//! Google OAuth（桌面应用：本机回环地址 + PKCE）。
//!
//! - 客户端文件：`%USERPROFILE%\.deskcalendar\google-oauth-client.json`（不在仓库中）
//! - 刷新令牌：Windows 凭据管理器（服务名 DeskCalendar）
//! - 访问令牌：只缓存在内存中，到期前 60 秒自动刷新

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

pub const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/tasks",
];
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const KEYRING_SERVICE: &str = "DeskCalendar";
const KEYRING_USER: &str = "google-refresh-token";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// 返回给前端的错误。code 供前端判断：NO_CLIENT_FILE / NOT_SIGNED_IN / REAUTH_REQUIRED / NETWORK / AUTH_FAILED / CREDENTIAL_STORE
#[derive(Debug, Serialize)]
pub struct AuthError {
    pub code: &'static str,
    pub message: String,
}

impl AuthError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

#[derive(Deserialize)]
struct ClientFile {
    installed: Option<ClientInfo>,
}

#[derive(Deserialize, Clone)]
struct ClientInfo {
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

struct CachedToken {
    access: String,
    expires: Instant,
}

#[derive(Default)]
pub struct Auth {
    token: Mutex<Option<CachedToken>>,
}

pub fn client_file_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    home.join(".deskcalendar").join("google-oauth-client.json")
}

fn load_client() -> Result<ClientInfo, AuthError> {
    let path = client_file_path();
    let text = std::fs::read_to_string(&path)
        .map_err(|_| AuthError::new("NO_CLIENT_FILE", format!("找不到 OAuth 客户端文件：{}", path.display())))?;
    serde_json::from_str::<ClientFile>(&text)
        .ok()
        .and_then(|f| f.installed)
        .ok_or_else(|| AuthError::new("NO_CLIENT_FILE", "OAuth 客户端文件格式不对：需要“桌面应用”类型（installed）"))
}

fn keyring_entry() -> Result<keyring::Entry, AuthError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| AuthError::new("CREDENTIAL_STORE", e.to_string()))
}

fn stored_refresh_token() -> Result<Option<String>, AuthError> {
    match keyring_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AuthError::new("CREDENTIAL_STORE", e.to_string())),
    }
}

fn delete_refresh_token() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

pub fn is_signed_in() -> bool {
    matches!(stored_refresh_token(), Ok(Some(_)))
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 从回环地址收到的第一行请求里取出参数。返回 None 表示与本次登录无关的请求（如 favicon）。
pub fn parse_callback(request_line: &str) -> Option<HashMap<String, String>> {
    let path = request_line.split_whitespace().nth(1)?;
    let url = Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
    (url.path() == "/").then(|| url.query_pairs().into_owned().collect())
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>DeskCalendar</title>\
         <body style=\"font-family:sans-serif;padding:40px\"><h2>{body}</h2></body>"
    );
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
}

async fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, AuthError> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| AuthError::new("AUTH_FAILED", e.to_string()))?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let Some(params) = req.lines().next().and_then(parse_callback) else {
            respond(&mut sock, "404 Not Found", "Not found").await;
            continue;
        };
        if let Some(err) = params.get("error") {
            respond(&mut sock, "200 OK", &format!("授权未完成：{err}。可以关闭此页面。")).await;
            return Err(AuthError::new("AUTH_FAILED", format!("授权未完成：{err}")));
        }
        match (params.get("code"), params.get("state")) {
            (Some(code), Some(s)) if s == state => {
                respond(&mut sock, "200 OK", "登录成功，可以关闭此页面，回到桌面组件。").await;
                return Ok(code.clone());
            }
            _ => respond(&mut sock, "400 Bad Request", "无效的回调请求").await,
        }
    }
}

async fn post_token(form: &[(&str, &str)]) -> Result<TokenResponse, Result<TokenError, AuthError>> {
    let res = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| Err(AuthError::new("NETWORK", e.to_string())))?;
    if res.status().is_success() {
        res.json::<TokenResponse>().await.map_err(|e| Err(AuthError::new("AUTH_FAILED", e.to_string())))
    } else {
        Err(res.json::<TokenError>().await.map_err(|e| AuthError::new("AUTH_FAILED", e.to_string())))
    }
}

impl Auth {
    /// 打开浏览器完成授权，把刷新令牌存入凭据管理器。
    pub async fn sign_in(&self, app: &AppHandle) -> Result<(), AuthError> {
        let client = load_client()?;
        let verifier = random_b64(48);
        let state = random_b64(16);
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| AuthError::new("AUTH_FAILED", e.to_string()))?;
        let port = listener.local_addr().map_err(|e| AuthError::new("AUTH_FAILED", e.to_string()))?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let scope = SCOPES.join(" ");
        let challenge = pkce_challenge(&verifier);
        let auth_url = Url::parse_with_params(
            AUTH_URL,
            [
                ("client_id", client.client_id.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("scope", scope.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("state", state.as_str()),
                ("access_type", "offline"),
                ("prompt", "consent"),
            ],
        )
        .expect("固定的授权地址");
        app.opener()
            .open_url(auth_url.as_str(), None::<&str>)
            .map_err(|e| AuthError::new("AUTH_FAILED", format!("无法打开浏览器：{e}")))?;

        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(listener, &state))
            .await
            .map_err(|_| AuthError::new("AUTH_FAILED", "等待授权超时（5 分钟）"))??;

        let token = post_token(&[
            ("code", code.as_str()),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .await
        .map_err(|e| match e {
            Ok(t) => AuthError::new("AUTH_FAILED", t.error_description.unwrap_or(t.error)),
            Err(e) => e,
        })?;
        let refresh = token
            .refresh_token
            .as_deref()
            .ok_or_else(|| AuthError::new("AUTH_FAILED", "Google 没有返回刷新令牌"))?;
        keyring_entry()?
            .set_password(refresh)
            .map_err(|e| AuthError::new("CREDENTIAL_STORE", e.to_string()))?;
        *self.token.lock().await = Some(CachedToken {
            access: token.access_token,
            expires: Instant::now() + Duration::from_secs(token.expires_in),
        });
        Ok(())
    }

    /// 返回有效的访问令牌，必要时用刷新令牌换新。
    pub async fn access_token(&self) -> Result<String, AuthError> {
        let mut cached = self.token.lock().await;
        if let Some(t) = cached.as_ref() {
            if t.expires > Instant::now() + Duration::from_secs(60) {
                return Ok(t.access.clone());
            }
        }
        let refresh = stored_refresh_token()?.ok_or_else(|| AuthError::new("NOT_SIGNED_IN", "尚未登录 Google"))?;
        let client = load_client()?;
        match post_token(&[
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .await
        {
            Ok(t) => {
                let access = t.access_token.clone();
                *cached = Some(CachedToken { access: t.access_token, expires: Instant::now() + Duration::from_secs(t.expires_in) });
                Ok(access)
            }
            // 刷新令牌失效（被撤销、过期，或同意屏幕仍处于"测试"状态满 7 天）
            Err(Ok(e)) if e.error == "invalid_grant" => {
                delete_refresh_token();
                Err(AuthError::new("REAUTH_REQUIRED", "登录已失效，请重新登录"))
            }
            Err(Ok(e)) => Err(AuthError::new("AUTH_FAILED", e.error_description.unwrap_or(e.error))),
            Err(Err(e)) => Err(e),
        }
    }

    /// 让访问令牌立即失效（前端收到 401 时调用）
    pub async fn invalidate(&self) {
        *self.token.lock().await = None;
    }

    pub async fn sign_out(&self) {
        if let Ok(Some(refresh)) = stored_refresh_token() {
            let _ = reqwest::Client::new().post(REVOKE_URL).form(&[("token", refresh.as_str())]).send().await;
        }
        delete_refresh_token();
        *self.token.lock().await = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_example() {
        // RFC 7636 附录 B 的示例
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn parses_callback_request_line() {
        let p = parse_callback("GET /?state=abc&code=4%2F0Ab HTTP/1.1").unwrap();
        assert_eq!(p.get("code").map(String::as_str), Some("4/0Ab"));
        assert_eq!(p.get("state").map(String::as_str), Some("abc"));
        assert!(parse_callback("GET /favicon.ico HTTP/1.1").is_none());
        assert!(parse_callback("garbage").is_none());
    }
}
