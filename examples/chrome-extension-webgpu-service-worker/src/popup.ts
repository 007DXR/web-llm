"use strict";

// This code is partially adapted from the openai-chatgpt-chrome-extension repo:
// https://github.com/jessedi0n/openai-chatgpt-chrome-extension

import "./popup.css";

import {
  ChatCompletionMessageParam,
  CreateExtensionServiceWorkerMLCEngine,
  MLCEngineInterface,
  InitProgressReport,
} from "@mlc-ai/web-llm";
import { ProgressBar, Line } from "progressbar.js";

/***************** UI elements *****************/
// Whether or not to use the content from the active tab as the context
const useContext = true;
console.log('useContext value:', useContext);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const queryInput = document.getElementById("query-input")!;
const submitButton = document.getElementById("submit-button")!;

let isLoadingParams = false;
let pageContext = ""; // Store the page context
let allTabContents: { title: string; url: string; content: string; html: string }[] = []; // Store individual tab contents with HTML
let tabGroups: { title: string; url: string; content: string; html: string }[][] = []; // Store grouped tabs

(<HTMLButtonElement>submitButton).disabled = true;

const progressBar: ProgressBar = new Line("#loadingContainer", {
  strokeWidth: 4,
  easing: "easeInOut",
  duration: 1400,
  color: "#ffd166",
  trailColor: "#eee",
  trailWidth: 1,
  svgStyle: { width: "100%", height: "100%" },
});

/***************** Web-LLM MLCEngine Configuration *****************/
const initProgressCallback = (report: InitProgressReport) => {
  progressBar.animate(report.progress, {
    duration: 50,
  });
  if (report.progress == 1.0) {
    enableInputs();
  }
};

const engine: MLCEngineInterface = await CreateExtensionServiceWorkerMLCEngine(
  "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  { initProgressCallback: initProgressCallback }
);


isLoadingParams = true;

function enableInputs() {
  if (isLoadingParams) {
    sleep(500);
    (<HTMLButtonElement>submitButton).disabled = false;
    const loadingBarContainer = document.getElementById("loadingContainer")!;
    loadingBarContainer.remove();
    queryInput.focus();
    isLoadingParams = false;
  }
}

/***************** Event Listeners *****************/

// Disable submit button if input field is empty
queryInput.addEventListener("keyup", () => {
  if ((<HTMLInputElement>queryInput).value === "") {
    (<HTMLButtonElement>submitButton).disabled = true;
  } else {
    (<HTMLButtonElement>submitButton).disabled = false;
  }
});

// If user presses enter, click submit button
queryInput.addEventListener("keyup", (event) => {
  if (event.code === "Enter") {
    event.preventDefault();
    submitButton.click();
  }
});

async function compressedContent(message, tabInfo)
{
        // Create a temporary message history for compression
  const compressionMessages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `Extract verbatim snippets from the provided text that directly answer the user's question.Constraints:
* Verbatim Substrings Only: Every bullet point must be a direct, unaltered substring of the source text. You must not add, remove, or change any characters, punctuation, or spacing.
* Zero Paraphrasing: Do not summarize or rewrite. If the text says "The apple is red," do not output "The apple's color is red."
* Negative Constraint: If the text does not contain a direct answer to the question, output exactly: No relevant information.
* Formatting: Use a bulleted list for multiple snippets.
* No Meta-talk: Do not include introductory remarks, explanations, or conclusions. Output only the snippets or the negative response.`
    },
    {
      role: "user",
      content: `CONTEXT: ${tabInfo.content}
  QUESTION: ${message}
  RESULT:`
    }
  ];

  // Get compressed content from the engine
  let compressedContent = "";
  const compressionCompletion = await engine.chat.completions.create({
    stream: true,
    messages: compressionMessages,
  });

  for await (const chunk of compressionCompletion) {
    const curDelta = chunk.choices[0].delta.content;
    if (curDelta) {
      compressedContent += curDelta;
    }
  }
  console.log(` compressed: ${compressedContent.length} characters；compressedContent:${compressedContent}`);
  return compressedContent
}

// ========== extract.js 完整实现 ==========

// 清理文本:移除多余空白
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// 标准化文本用于模糊匹配:转小写、移除标点、统一空格
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 模糊匹配:检查text2是否包含在text1中
function fuzzyIncludes(text1: string, text2: string): boolean {
  const normalized1 = normalizeText(text1);
  const normalized2 = normalizeText(text2);
  return normalized1.includes(normalized2);
}

// 解析output文件,提取各个字段
function parseOutput(outputText: string): string[] {
  const lines = outputText.trim().split('\n').filter(line => line.trim());
  return lines;
}

// 在HTML中查找包含指定文本的最小元素
function findElementContainingText(doc: Document, text: string): Element | null {
  const cleanedText = cleanText(text);
  let bestMatch: Element | null = null;
  let minLength = Infinity;
  
  function traverse(node: Element) {
    if (node.nodeType === 1) {
      const nodeText = cleanText(node.textContent || '');
      
      if (fuzzyIncludes(nodeText, cleanedText)) {
        // 检查子元素是否也包含该文本
        let childContains = false;
        for (let child of Array.from(node.children)) {
          const childText = cleanText(child.textContent || '');
          if (fuzzyIncludes(childText, cleanedText)) {
            childContains = true;
            break;
          }
        }
        
        // 如果子元素不包含,且文本长度更短,更新最佳匹配
        if (!childContains && nodeText.length < minLength) {
          bestMatch = node;
          minLength = nodeText.length;
        }
      }
      
      for (let child of Array.from(node.children)) {
        traverse(child as Element);
      }
    }
  }
  
  traverse(doc.body);
  return bestMatch;
}

// 提取元素的特征
interface ElementFeatures {
  tagName: string;
  classes: string[];
  id: string | null;
  itemprop: string | null;
  attributes: { [key: string]: string };
  parentTag: string | null;
  parentClasses: string[];
  parentId: string | null;
  ancestorClasses: string[];
  dataAttributes: { [key: string]: string };
  path: Array<{ tagName: string; id: string | null; classes: string[] }>;
}

function extractElementFeatures(element: Element): ElementFeatures {
  const features: ElementFeatures = {
    tagName: element.tagName.toLowerCase(),
    classes: [],
    id: element.id || null,
    itemprop: null,
    attributes: {},
    parentTag: null,
    parentClasses: [],
    parentId: null,
    ancestorClasses: [],
    dataAttributes: {},
    path: []
  };
  
  // 提取类名
  if (element.className && typeof element.className === 'string') {
    features.classes = element.className.trim().split(/\s+/).filter(c => c);
  }
  
  // 提取itemprop属性
  if (element.hasAttribute('itemprop')) {
    features.itemprop = element.getAttribute('itemprop');
  }
  
  // 提取父元素信息
  if (element.parentElement) {
    features.parentTag = element.parentElement.tagName.toLowerCase();
    features.parentId = element.parentElement.id || null;
    if (element.parentElement.className && typeof element.parentElement.className === 'string') {
      features.parentClasses = element.parentElement.className.trim().split(/\s+/).filter(c => c);
    }
  }
  
  // 提取祖先元素的类名(向上3层)
  let ancestor = element.parentElement;
  for (let i = 0; i < 3 && ancestor; i++) {
    if (ancestor.className && typeof ancestor.className === 'string') {
      const classes = ancestor.className.trim().split(/\s+/).filter(c => c);
      features.ancestorClasses.push(...classes);
    }
    ancestor = ancestor.parentElement;
  }
  
  // 提取关键属性
  for (let attr of Array.from(element.attributes)) {
    if (['class', 'id', 'itemprop', 'title'].includes(attr.name)) {
      features.attributes[attr.name] = attr.value;
    }
    // 提取data-*属性
    if (attr.name.startsWith('data-')) {
      features.dataAttributes[attr.name] = attr.value;
    }
  }
  
  // 构建路径
  let current: Element | null = element;
  while (current && current.tagName) {
    const pathItem = {
      tagName: current.tagName.toLowerCase(),
      id: current.id || null,
      classes: current.className && typeof current.className === 'string'
        ? current.className.trim().split(/\s+/).filter(c => c)
        : []
    };
    features.path.unshift(pathItem);
    current = current.parentElement;
  }
  
  return features;
}

// 计算元素相似度
function calculateSimilarity(element: Element, targetFeatures: ElementFeatures): number {
  let score = 0;
  
  // 标签名匹配
  if (element.tagName.toLowerCase() === targetFeatures.tagName) {
    score += 10;
  }
  
  // ID匹配（非常重要）
  if (targetFeatures.id && element.id === targetFeatures.id) {
    score += 100;
  }
  
  // itemprop属性匹配(非常重要)
  if (targetFeatures.itemprop && element.hasAttribute('itemprop') &&
      element.getAttribute('itemprop') === targetFeatures.itemprop) {
    score += 100;
  }
  
  // 类名匹配
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/).filter(c => c);
    const matchingClasses = classes.filter(c => targetFeatures.classes.includes(c));
    score += matchingClasses.length * 8;
  }
  
  // 父元素标签匹配
  if (element.parentElement && element.parentElement.tagName.toLowerCase() === targetFeatures.parentTag) {
    score += 5;
  }
  
  // 父元素ID匹配
  if (targetFeatures.parentId && element.parentElement && element.parentElement.id === targetFeatures.parentId) {
    score += 50;
  }
  
  // 父元素类名匹配
  if (element.parentElement && element.parentElement.className && typeof element.parentElement.className === 'string') {
    const parentClasses = element.parentElement.className.trim().split(/\s+/).filter(c => c);
    const matchingParentClasses = parentClasses.filter(c => targetFeatures.parentClasses.includes(c));
    score += matchingParentClasses.length * 3;
  }
  
  // 祖先元素类名匹配
  let ancestor = element.parentElement;
  const elementAncestorClasses: string[] = [];
  for (let i = 0; i < 3 && ancestor; i++) {
    if (ancestor.className && typeof ancestor.className === 'string') {
      const classes = ancestor.className.trim().split(/\s+/).filter(c => c);
      elementAncestorClasses.push(...classes);
    }
    ancestor = ancestor.parentElement;
  }
  const matchingAncestorClasses = elementAncestorClasses.filter(c => targetFeatures.ancestorClasses.includes(c));
  score += matchingAncestorClasses.length * 2;
  
  // data属性匹配
  for (let key in targetFeatures.dataAttributes) {
    if (element.hasAttribute(key) && element.getAttribute(key) === targetFeatures.dataAttributes[key]) {
      score += 15;
    }
  }
  
  return score;
}

// 在目标文档中查找相似的元素
function findSimilarElement(doc: Document, features: ElementFeatures): Element | null {
  let bestCandidate: Element | null = null;
  let bestScore = 0;
  
  function traverse(node: Element) {
    if (node.nodeType === 1) {
      const score = calculateSimilarity(node, features);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = node;
      }
      
      for (let child of Array.from(node.children)) {
        traverse(child as Element);
      }
    }
  }
  
  traverse(doc.body);
  return bestCandidate;
}

// 从元素及其兄弟元素中提取文本内容
function extractTextFromElementAndSiblings(element: Element, originalText: string): string {
  const texts: string[] = [];
  
  // 提取当前元素的文本
  const currentText = extractTextFromElement(element, originalText);
  if (currentText) {
    texts.push(currentText);
  }
  
  // 提取所有兄弟元素的文本
  if (element.parentElement) {
    const siblings = Array.from(element.parentElement.children);
    for (const sibling of siblings) {
      if (sibling !== element) {
        const siblingText = cleanText(sibling.textContent || '');
        if (siblingText) {
          texts.push(siblingText);
        }
      }
    }
  }
  
  // 合并所有文本，用空格分隔
  return texts.join(' ');
}

// 从元素中提取对应格式的文本
function extractTextFromElement(element: Element, originalText: string): string {
  const text = cleanText(element.textContent || '');
  
  // 如果原文本包含美元符号,提取价格
  if (originalText.includes('$')) {
    const match = text.match(/\$[\d.,]+/);
    if (match) return match[0];
  }
  
  // 如果原文本包含百分号,提取百分比
  if (originalText.includes('%')) {
    const match = text.match(/(\d+)%/);
    if (match) return match[1] + '%';
    // 尝试从title属性提取
    if (element.hasAttribute('title')) {
      const titleMatch = element.getAttribute('title')!.match(/(\d+)%/);
      if (titleMatch) return titleMatch[1] + '%';
    }
  }
  
  // 如果原文本包含Reviews,提取评论数
  // if (originalText.includes('Reviews')) {
  //   const match = text.match(/(\d+)\s*Reviews?/i);
  //   if (match) return match[1] + ' Reviews';
  // }
  
  // 否则返回清理后的文本
  return text;
}

// 向上查找包含列表的容器元素
function findListContainer(element: Element): Element | null {
  let current: Element | null = element;
  
  // 向上查找,直到找到包含 ul 或有 id 的 div
  while (current) {
    // 如果当前元素是 li,继续向上找 ul
    if (current.tagName.toLowerCase() === 'li') {
      current = current.parentElement;
      continue;
    }
    
    // 如果找到 ul,返回它
    if (current.tagName.toLowerCase() === 'ul') {
      return current;
    }
    
    // 如果找到有 id 的 div 且包含 ul,返回这个 div
    if (current.tagName.toLowerCase() === 'div' && current.id) {
      const ul = current.querySelector('ul');
      if (ul) {
        return current;
      }
    }
    
    current = current.parentElement;
  }
  
  return null;
}

// 从容器中提取所有列表项及其兄弟元素的内容
function extractListItems(container: Element): string[] {
  const items: string[] = [];
  
  // 查找所有 li 元素
  const listItems = container.querySelectorAll('li');
  
  for (let li of Array.from(listItems)) {
    // 优先提取 span.a-list-item 的文本
    const span = li.querySelector('span.a-list-item');
    const mainText = span ? span.textContent : li.textContent;
    const cleanedMainText = cleanText(mainText || '');
    
    if (cleanedMainText) {
      items.push(cleanedMainText);
    }
  }
  
  return items;
}

// 检查是否所有字段都来自同一个列表容器
function checkIfListMode(doc: Document, fields: string[]): boolean {
  if (fields.length <= 1) return false;
  
  const firstElement = findElementContainingText(doc, fields[0]);
  if (!firstElement) return false;
  
  const container = findListContainer(firstElement);
  if (!container) return false;
  
  // 检查其他字段是否也在同一个容器中
  for (let i = 1; i < fields.length; i++) {
    const element = findElementContainingText(doc, fields[i]);
    if (!element) return false;
    
    const elementContainer = findListContainer(element);
    if (elementContainer !== container) return false;
  }
  
  return true;
}

// 清理 HTML 以避免 CSP 违规
function sanitizeHtmlForParsing(html: string): string {
  return html?html
    // 移除内联样式属性 - 使用更精确的匹配，支持值中包含引号的情况
    .replace(/\s+style\s*=\s*"(?:[^"\\]|\\.)*"/gi, '') // 匹配双引号包裹的 style
    .replace(/\s+style\s*=\s*'(?:[^'\\]|\\.)*'/gi, '') // 匹配单引号包裹的 style
    // 移除 script 标签及其内容
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // 移除内联事件处理器 (onclick, onload 等) - 同样改进匹配
    .replace(/\s+on\w+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '')
    .replace(/\s+on\w+\s*=\s*'(?:[^'\\]|\\.)*'/gi, ''):"";
}

// 使用 extract.js 的逻辑从 input2Html 中提取内容
async function extractContentUsingTemplate(inputHtml: string, outputText: string, input2Html: string): Promise<string> {
  try {
    const parser = new DOMParser();

    const dom1 = parser.parseFromString(inputHtml, 'text/html');
    const dom2 = parser.parseFromString(input2Html, 'text/html');
    
    console.log('=== 开始分析提取规则 ===');
    
    // 解析output文件
    const outputFields = parseOutput(outputText);
    console.log(`从压缩内容中解析出 ${outputFields.length} 个字段`);
    
    if (outputFields.length === 0) {
      console.log('错误: 压缩内容中没有找到字段');
      return outputText;
    }
    
    // 检查是列表模式还是字段模式
    const isListMode = checkIfListMode(dom1, outputFields);
    console.log(`检测到模式: ${isListMode ? '列表模式' : '字段模式'}`);
    
    let extractedItems: string[] = [];
    
    if (isListMode) {
      // 列表模式：从同一个容器提取所有项
      console.log('使用列表模式提取...');
      
      const firstField = outputFields[0];
      const element1 = findElementContainingText(dom1, firstField);
      
      if (!element1) {
        console.log('错误: 在模板HTML中未找到匹配的元素');
        return outputText;
      }
      
      const container1 = findListContainer(element1);
      if (!container1) {
        console.log('错误: 未找到列表容器');
        return outputText;
      }
      
      console.log(`找到列表容器: <${container1.tagName.toLowerCase()}${container1.id ? ' id="' + container1.id + '"' : ''}>`);
      
      const containerFeatures = extractElementFeatures(container1);
      const container2 = findSimilarElement(dom2, containerFeatures);
      
      if (!container2) {
        console.log('错误: 在目标HTML中未找到相似的容器');
        return outputText;
      }
      
      console.log(`在目标HTML中找到相似容器: <${container2.tagName.toLowerCase()}${container2.id ? ' id="' + container2.id + '"' : ''}>`);
      
      extractedItems = extractListItems(container2);
      console.log(`从容器中提取了 ${extractedItems.length} 个列表项`);
      
    } else {
      // 字段模式：分别提取每个字段
      console.log('使用字段模式提取...');
      
      for (let i = 0; i < outputFields.length; i++) {
        const field = outputFields[i];
        console.log(`\n处理字段 ${i + 1}/${outputFields.length}: ${field}`);
        
        const element1 = findElementContainingText(dom1, field);
        if (!element1) {
          console.log(`  未找到匹配的元素`);
          extractedItems.push('');
          continue;
        }
        
        console.log(`  找到元素: <${element1.tagName.toLowerCase()}>`);
        
        const features = extractElementFeatures(element1);
        const element2 = findSimilarElement(dom2, features);
        
        if (!element2) {
          console.log(`  在目标HTML中未找到相似元素`);
          extractedItems.push('');
          continue;
        }
        
        console.log(`  在目标HTML中找到相似元素: <${element2.tagName.toLowerCase()}>`);
        
        // 提取元素及其兄弟元素的内容
        const extractedText = extractTextFromElement(element2, field);
        console.log(`  提取结果: ${extractedText}`);
        
        extractedItems.push(extractedText);
      }
    }
    
    // 格式化输出
    const output2 = extractedItems.map(item => `* ${item}`).join('\n');
    
    console.log('\n=== 提取完成 ===');
    console.log(`提取的内容:`);
    extractedItems.forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.substring(0, 100)}${item.length > 100 ? '...' : ''}`);
    });
    
    return output2;
  } catch (error) {
    console.error('提取内容时出错:', error);
    return outputText; // 出错时返回原始输出
  }
}

// Listen for clicks on submit button
async function handleClick() {
  // Get the message from the input field
  const message = (<HTMLInputElement>queryInput).value;
  console.log("message", message);

  // Clear the answer
  document.getElementById("answer")!.innerHTML = "";
  // Hide the answer
  document.getElementById("answerWrapper")!.style.display = "none";
  // Show the loading indicator
  document.getElementById("loading-indicator")!.style.display = "block";
  let chatHistory: ChatCompletionMessageParam[] = [];
  let finalMessages: ChatCompletionMessageParam[] = [];

  // Check if we have multiple tabs
  if (allTabContents.length > 1) {
    console.log(`Processing ${allTabContents.length} tabs in ${tabGroups.length} groups...`);

    // Phase 1: Process each group
    const compressedTabContents: { title: string; url: string; compressed: string }[] = [];

    for (let groupIdx = 0; groupIdx < tabGroups.length; groupIdx++) {
      const group = tabGroups[groupIdx];
      console.log(`\n处理组 ${groupIdx + 1}/${tabGroups.length}，包含 ${group.length} 个标签页`);

      if (group.length === 1) {
        // 单个标签页的组，直接压缩
        const tabInfo = group[0];
        console.log(`  单标签页组: ${tabInfo.title}`);
        
        const compressed = await compressedContent(message, tabInfo);
        compressedTabContents.push({
          title: tabInfo.title,
          url: tabInfo.url,
          compressed: compressed
        });
      } else {
        // 多个标签页的组，使用 extract 逻辑
        console.log(`  多标签页组，选择第一个标签页作为模板`);
        
        // 选择第一个有效的标签页作为模板
        let templateTab: { title: string; url: string; content: string; html: string } | null = null;
        let templateCompressed = "";
        let templateIndex = -1;
        
        for (let i = 0; i < group.length; i++) {
          const currentTab = group[i];
          console.log(`  尝试模板标签页 ${i + 1}: ${currentTab.title}`);
          
          // 压缩模板标签页的内容
          const compressed = await compressedContent(message, currentTab);
          console.log(`  模板压缩完成: ${compressed.length} 字符`);
          
          // 如果压缩结果不是 "No relevant information"，则使用此标签页
          if (!compressed.includes( "No relevant information")) {
            templateTab = currentTab;
            templateCompressed = compressed;
            templateIndex = i;
            console.log(`  选定模板标签页 ${i + 1}: ${templateTab.title}`);
            break;
          }
          
          console.log(`  标签页 ${i + 1} 无相关信息，尝试下一个`);
        }
        
        // 将模板标签页添加到结果中
        if (templateTab) {
          compressedTabContents.push({
            title: templateTab.title,
            url: templateTab.url,
            compressed: templateCompressed
          });
          
          // 对组内其他标签页使用 extract 逻辑
          for (let i = templateIndex+1; i < group.length; i++) {
            
            const otherTab = group[i];
            console.log(`  使用 extract 处理: ${otherTab.title}`);
            
            try {
              // 使用 extract 逻辑从其他标签页中提取内容
              const extractedContent = await extractContentUsingTemplate(
                templateTab.html,
                templateCompressed,
                otherTab.html
              );
              
              console.log(`  提取完成: ${extractedContent.length} 字符`);
              
              compressedTabContents.push({
                title: otherTab.title,
                url: otherTab.url,
                compressed: extractedContent
              });
            } catch (error) {
              console.error(`  提取失败，回退到直接压缩:`, error);
              // 如果提取失败，回退到直接压缩
              const compressed = await compressedContent(message, otherTab);
              compressedTabContents.push({
                title: otherTab.title,
                url: otherTab.url,
                compressed: compressed
              });
            }
          }
        } else {
          console.log(`  警告: 所有标签页都没有相关信息，跳过此组`);
        }
      }
    }

    // Phase 2: Combine all compressed contents and generate final answer
    const combinedCompressedContext = compressedTabContents
      .map((tabInfo, index) =>
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\nRelevant Information: ${tabInfo.compressed}\n`
      )
      .join("\n");

    console.log("\n所有标签页处理完成，生成最终答案...");

    // Create final message history with compressed context
    finalMessages = [
      {
        role: "system",
        content: `You are a helpful assistant. The user has ${allTabContents.length} browser tabs open. Below is the relevant information extracted from each tab based on the user's question:\n\n${combinedCompressedContext}\n\nPlease provide a comprehensive answer to the user's question based on this information.`
      },
      {
        role: "user",
        content: message
      }
    ];
  } else {
    // Single tab or no tabs: use original logic
    console.log("Single tab or no tabs, using original logic...");
    // Combine all tab contents into a single context (for single-tab fallback)
    pageContext = allTabContents
      .map((tabInfo, index) =>
        `=== Tab ${index + 1}: ${tabInfo.title} ===\nURL: ${tabInfo.url}\n\n${tabInfo.content}\n\n`
      )
      .join("\n");
    // For single tab, use original logic
    chatHistory.push({
      role: "system",
      content: `You are a helpful assistant. Here is the content of the browser tab:\n\n${pageContext}\n\nPlease answer questions about this webpage based on the content provided above.`
    });
    console.log("Single tab content loaded:", pageContext.substring(0, 200) + "...");
    chatHistory.push({ role: "user", content: message });
    finalMessages = chatHistory;
  }

  console.log("Final messages:", finalMessages);

  // Send the final chat completion message to the engine
  let curMessage = "";
  try {
    console.log("Creating chat completion...");
    const completion = await engine.chat.completions.create({
      stream: true,
      messages: finalMessages,
    });

    console.log("Starting to receive chunks...");
    let chunkCount = 0;
    // Update the answer as the model generates more text
    for await (const chunk of completion) {
      chunkCount++;
      const curDelta = chunk.choices[0].delta.content;
      if (curDelta) {
        curMessage += curDelta;
        console.log(`Chunk ${chunkCount}: received ${curDelta.length} chars`);
      }
      updateAnswer(curMessage);
    }
    console.log(`Total chunks received: ${chunkCount}, total message length: ${curMessage.length}`);

    // Update chat history
    chatHistory.push({ role: "assistant", content: await engine.getMessage() });
  } catch (error) {
    console.error("Error during chat completion:", error);
    // Show error message to user
    const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
    updateAnswer(errorMessage);
  }
}

submitButton.addEventListener("click", handleClick);

function updateAnswer(answer: string) {
  // Show answer
  document.getElementById("answerWrapper")!.style.display = "block";
  const answerWithBreaks = answer.replace(/\n/g, "<br>");
  document.getElementById("answer")!.innerHTML = answerWithBreaks;
  // Add event listener to copy button
  document.getElementById("copyAnswer")!.addEventListener("click", () => {
    // Get the answer text
    const answerText = answer;
    // Copy the answer text to the clipboard
    navigator.clipboard
      .writeText(answerText)
      .then(() => console.log("Answer text copied to clipboard"))
      .catch((err) => console.error("Could not copy text: ", err));
  });
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  };
  const time = new Date().toLocaleString("en-US", options);
  // Update timestamp
  document.getElementById("timestamp")!.innerText = time;
  // Hide loading indicator
  document.getElementById("loading-indicator")!.style.display = "none";
}

// 计算两个 URL 的相似度
function calculateUrlSimilarity(url1: string, url2: string): number {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    
    let score = 0;
    
    // 域名完全相同
    if (u1.hostname === u2.hostname) {
      score += 50;
    }
    
    // 路径相似度
    const path1Parts = u1.pathname.split('/').filter(p => p);
    const path2Parts = u2.pathname.split('/').filter(p => p);
    const commonPathParts = path1Parts.filter((p, i) => path2Parts[i] === p).length;
    score += commonPathParts * 10;
    
    return score;
  } catch {
    return 0;
  }
}

// 计算两个 HTML 的 DOM 结构相似度
function calculateDomSimilarity(html1: string, html2: string): number {
  try {
    const parser = new DOMParser();
    const doc1 = parser.parseFromString(html1, 'text/html');
    const doc2 = parser.parseFromString(html2, 'text/html');
    
    // 提取主要标签的数量和类型
    const getTags = (doc: Document) => {
      const tags: { [key: string]: number } = {};
      const elements = doc.querySelectorAll('*');
      elements.forEach(el => {
        const tag = el.tagName.toLowerCase();
        tags[tag] = (tags[tag] || 0) + 1;
      });
      return tags;
    };
    
    const tags1 = getTags(doc1);
    const tags2 = getTags(doc2);
    
    // 计算标签相似度
    let score = 0;
    const allTags = new Set([...Object.keys(tags1), ...Object.keys(tags2)]);
    
    allTags.forEach(tag => {
      const count1 = tags1[tag] || 0;
      const count2 = tags2[tag] || 0;
      const diff = Math.abs(count1 - count2);
      const max = Math.max(count1, count2);
      if (max > 0) {
        score += (1 - diff / max) * 2;
      }
    });
    
    return score;
  } catch {
    return 0;
  }
}

// 将标签页分组
function groupTabs(tabs: { title: string; url: string; content: string; html: string }[]): { title: string; url: string; content: string; html: string }[][] {
  if (tabs.length === 0) return [];
  if (tabs.length === 1) return [tabs];
  
  const groups: { title: string; url: string; content: string; html: string }[][] = [];
  const used = new Set<number>();
  
  for (let i = 0; i < tabs.length; i++) {
    if (used.has(i)) continue;
    
    const group = [tabs[i]];
    used.add(i);
    
    for (let j = i + 1; j < tabs.length; j++) {
      if (used.has(j)) continue;
      
      const urlSim = calculateUrlSimilarity(tabs[i].url, tabs[j].url);
      const domSim = calculateDomSimilarity(tabs[i].html, tabs[j].html);
      const totalSim = urlSim + domSim;
      
      // 如果相似度超过阈值，加入同一组
      if (totalSim > 60) {
        group.push(tabs[j]);
        used.add(j);
      }
    }
    
    groups.push(group);
  }
  
  console.log(`标签页分组完成: ${groups.length} 个组`);
  groups.forEach((group, idx) => {
    console.log(`组 ${idx + 1}: ${group.length} 个标签页`);
    group.forEach(tab => console.log(`  - ${tab.title}`));
  });
  
  return groups;
}

function fetchPageContents() {
  // Query all tabs in the current window instead of just the active one
  chrome.tabs.query({ currentWindow: true }, function (tabs) {
    let completedTabs = 0;
    const totalTabs = tabs.length;

    if (tabs.length === 0) {
      console.warn("⚠️ No tabs found in current window");
      return;
    }

    tabs.forEach((tab) => {
      if (tab.id) {
        try {
          const port = chrome.tabs.connect(tab.id, { name: "channelName" });
          port.postMessage({});
          port.onMessage.addListener(function (msg) {
            // Store each tab's content with metadata in the global array
            allTabContents.push({
              title: tab.title || "Untitled",
              url: tab.url || "Unknown URL",
              content: msg.contents,
              html: sanitizeHtmlForParsing(msg.html) || ""
            });

            console.log(msg.contents);
            
            completedTabs++;
            // 当所有标签页内容都获取完成后，进行分组
            if (completedTabs === totalTabs) {
              tabGroups = groupTabs(allTabContents);
              console.log(`所有标签页内容已获取并分组完成`);
            }
          });
          port.onDisconnect.addListener(() => {
            if (chrome.runtime.lastError) {
              // Suppress the error and show a warning instead
              console.warn(`⚠️ Could not connect to tab ${tab.id} (${tab.title || 'Untitled'}): ${chrome.runtime.lastError.message}. This may happen if the extension was recently reloaded - please refresh the page to enable content extraction.`);
              completedTabs++;
              if (completedTabs === totalTabs) {
                tabGroups = groupTabs(allTabContents);
                console.log(`所有标签页内容已获取并分组完成`);
              }
            }
          });
        } catch (error) {
          console.warn(`⚠️ Failed to connect to tab ${tab.id} (${tab.title || 'Untitled'}): ${error instanceof Error ? error.message : String(error)}. This may happen if the extension was recently reloaded - please refresh the page.`);
          completedTabs++;
          if (completedTabs === totalTabs) {
            tabGroups = groupTabs(allTabContents);
            console.log(`所有标签页内容已获取并分组完成`);
          }
        }
      } else {
        completedTabs++;
        if (completedTabs === totalTabs) {
          tabGroups = groupTabs(allTabContents);
          console.log(`所有标签页内容已获取并分组完成`);
        }
      }
    });
  });
  
}


// Grab the page contents when the popup is opened
// Use DOMContentLoaded instead of window.onload to ensure it fires
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (useContext) {
      fetchPageContents();
    }
  });
} else {
  // Document already loaded
  if (useContext) {
    fetchPageContents();
  }
}