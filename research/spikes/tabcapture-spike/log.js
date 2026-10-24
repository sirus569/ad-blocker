const out = document.getElementById('out');
const render = async () => {
  const { log = [] } = await chrome.storage.local.get('log');
  out.textContent = log.length ? log.slice().reverse().join('\n') : '(no log yet)';
};
render();
chrome.storage.onChanged.addListener(render);
document.getElementById('clear').onclick = () => chrome.storage.local.set({ log: [] });
