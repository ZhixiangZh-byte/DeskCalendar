const { invoke } = window.__TAURI__.core;
const log = (kind, data = null) => invoke('log_event', { kind, data }).catch(() => {});

/** 报告各控件中心点（物理像素，相对窗口左上角），供自动化测试定位 */
function reportLayout() {
  const dpr = window.devicePixelRatio;
  const center = (sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return [Math.round((r.left + r.width / 2) * dpr), Math.round((r.top + r.height / 2) * dpr)];
  };
  log('layout', { dpr, counter: center('#counter'), text: center('#text'), header: center('header'), opacity: center('#opacity') });
}

window.addEventListener('DOMContentLoaded', async () => {
  const st = await invoke('status');
  document.querySelector('#mode').textContent = st.mode;
  document.querySelector('#host').textContent = st.error ? `失败：${st.error}` : st.host ? `${st.host_class} (0x${st.host.toString(16)})` : '无（普通窗口）';

  let n = 0;
  const counter = document.querySelector('#counter');
  counter.addEventListener('click', () => {
    counter.textContent = `点击测试：${++n}`;
    log('click', n);
  });
  window.addEventListener('pointerdown', (e) => log('pointerdown', [e.clientX, e.clientY]));

  const echo = document.querySelector('#echo');
  document.querySelector('#text').addEventListener('input', (e) => {
    echo.textContent = e.target.value || '（输入内容会显示在这里）';
    log('input', e.target.value);
  });
  window.addEventListener('keydown', (e) => log('keydown', e.key));

  const card = document.querySelector('#card');
  const opacity = document.querySelector('#opacity');
  const apply = () => card.style.setProperty('--bg-alpha', opacity.value / 100);
  opacity.addEventListener('input', () => {
    apply();
    log('opacity', Number(opacity.value));
  });
  apply();

  document.querySelector('#through').addEventListener('click', () => invoke('click_through_for', { seconds: 5 }));
  reportLayout();
  window.addEventListener('resize', reportLayout);
});
