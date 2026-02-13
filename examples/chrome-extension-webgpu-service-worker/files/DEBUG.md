## 问题
Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist.



## 修改内容

1. **改进错误处理**：在 [`port.onDisconnect`](src/popup.ts:195) 监听器中添加了 `chrome.runtime.lastError` 检查，将错误转换为警告消息

2. **友好的警告信息**：
   - 当无法连接到标签页时，显示清晰的警告信息，说明可能是因为扩展重新加载导致
   - 提示用户刷新页面以启用内容提取功能

3. **增强的异常捕获**：在 [`try-catch`](src/popup.ts:207) 块中将 `console.error` 改为 `console.warn`，并提供更详细的错误信息

4. **空内容检测**：当所有标签页都无法获取内容时，显示特定的警告消息，提醒用户可能需要刷新标签页

## 效果

现在当遇到以下情况时，不会在控制台显示红色错误，而是显示黄色警告：
- 扩展重新加载后，旧标签页的 content script 失效
- 尝试连接到受限页面（chrome://, chrome-extension:// 等）
- Content script 未加载或未准备好

用户会看到清晰的提示信息，知道需要刷新页面才能正常使用内容提取功能。