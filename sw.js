/* 扩展的入口：点工具栏图标 → 打开（或切回）课堂同传页面。
 *
 * 为什么开的是标签页而不是 action.default_popup：
 *   popup 一失焦就被销毁，而语音识别必须在一个有 DOM 的页面里持续跑——整节课都在
 *   识别，popup 撑不过一次点到别处。这一条是硬约束，不是偏好。
 *
 * 刻意不申请 "tabs" 权限：用 chrome.storage.session 记住标签页 id，
 * 再配合 chrome.tabs.get/update 就够了，不需要去读任何别的标签页的 URL。
 */
const APP = 'app.html';
const KEY = 'cpTabId';

async function openApp(){
  const got = await chrome.storage.session.get(KEY);
  const id = got[KEY];
  if (id != null){
    try {
      const tab = await chrome.tabs.get(id);
      // 切回它，并把窗口提到最前——否则点了图标像"没反应"
      await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch (e) { /* 那个标签页已经被关了，往下新建 */ }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(APP) });
  await chrome.storage.session.set({ [KEY]: tab.id });
}

chrome.action.onClicked.addListener(openApp);

// 装好之后自动开一次。Edge 会把新扩展的图标塞进工具栏的拼图菜单里，
// 不主动开页面的话很容易以为"装上了但没看见"。
chrome.runtime.onInstalled.addListener(openApp);

// 页面关掉就清掉记的 id，否则下次点图标会去 activate 一个不存在的标签页
chrome.tabs.onRemoved.addListener(async (id) => {
  const got = await chrome.storage.session.get(KEY);
  if (got[KEY] === id) await chrome.storage.session.remove(KEY);
});
