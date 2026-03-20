const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  projectApi: process.env.PROJECT_API,
  apiKey: process.env.API_KEY,
  targetWebhook: process.env.TARGET_WEBHOOK,
  pollInterval: parseInt(process.env.POLL_INTERVAL),
  strmTasks: process.env.STRM_TASKS?.split(','),
  filterStatus: process.env.FILTER_STATUS,
  persistFile: path.join(__dirname, 'data/sent-tasks.json'),
  logsApi: process.env.LOGS_API || process.env.PROJECT_API?.replace('/api/tasks', '/api/logs/events'),
  dedupeWindow: 60 * 1000 // 1分钟去重窗口期（毫秒）
};

// ===== 上海时间格式化 =====
function getShanghaiTime() {
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date()).replace(/\//g, '-');
}

// ===== 路径截取（完全保留原有逻辑）=====
function extractTargetPath(realFolderName, resourceName) {
  if (!realFolderName || !resourceName) return '';
  const cleanPath = realFolderName.trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '').toLowerCase();
  const cleanResource = resourceName.trim().replace(/\(根\)$/i, '').toLowerCase();
  const pathParts = cleanPath.split('/').filter(part => part.trim() !== '');
  if (pathParts.length === 0) return '';
  const resourceIndex = pathParts.findIndex(part => part.includes(cleanResource));
  if (resourceIndex === -1) return '';
  const targetParts = pathParts.slice(0, resourceIndex);
  return targetParts.length > 0 ? `/${targetParts.join('/')}` : '';
}

// ===== 持久化存储（记录已推送任务时间）=====
function initSentTaskRecords() {
  try {
    const dataDir = path.dirname(CONFIG.persistFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(CONFIG.persistFile)) {
      const content = fs.readFileSync(CONFIG.persistFile, 'utf8');
      return JSON.parse(content || '{}');
    } else {
      fs.writeFileSync(CONFIG.persistFile, '{}', 'utf8');
      return {};
    }
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 初始化任务记录失败:`, error.message);
    return {};
  }
}

function saveSentTaskRecords(records) {
  try {
    fs.writeFileSync(CONFIG.persistFile, JSON.stringify(records), 'utf8');
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 保存任务记录失败:`, error.message);
  }
}

// 全局变量初始化
let sentTaskRecords = initSentTaskRecords();
let pendingRenameTasks = new Map(); // 待重命名任务队列（key: task.id）
let delayedPushCache = new Map();   // 延迟推送缓存（key: targetPath）

// ===== 日志频率控制（1分钟只打一次无任务日志）=====
let lastNoTaskLogAt = 0;
const NO_TASK_LOG_INTERVAL = 60 * 1000;

// ===== 环境变量检查（无delay相关）=====
function checkRequiredEnv() {
  const required = [
    { key: 'PROJECT_API', value: CONFIG.projectApi },
    { key: 'API_KEY', value: CONFIG.apiKey },
    { key: 'TARGET_WEBHOOK', value: CONFIG.targetWebhook },
    { key: 'STRM_TASKS', value: CONFIG.strmTasks },
    { key: 'FILTER_STATUS', value: CONFIG.filterStatus },
    { key: 'POLL_INTERVAL', value: CONFIG.pollInterval }
  ];
  const missing = required.filter(item => !item.value);
  if (missing.length > 0) {
    console.error(`[${getShanghaiTime()}] ❌ 缺少必填环境变量：`);
    missing.forEach(item => console.error(`   - ${item.key}`));
    process.exit(1);
  }
}

// ===== 步骤1：轮询tasks - 发现新/更新任务加入待重命名队列 =====
async function pollTasks() {
  try {
    const res = await axios.get(CONFIG.projectApi, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });

    if (!res.data?.success || !Array.isArray(res.data.data)) {
      const now = Date.now();
      if (now - lastNoTaskLogAt >= NO_TASK_LOG_INTERVAL) {
        console.log(`[${getShanghaiTime()}] API无有效数据`);
        lastNoTaskLogAt = now;
      }
      return;
    }

    const tasks = res.data.data.filter(task =>
      task.status === CONFIG.filterStatus &&
      task.realFolderName
    );

    if (tasks.length === 0) {
      const now = Date.now();
      if (now - lastNoTaskLogAt >= NO_TASK_LOG_INTERVAL) {
        console.log(`[${getShanghaiTime()}] ⏳ 暂无新任务`);
        lastNoTaskLogAt = now;
      }
      return;
    }

    lastNoTaskLogAt = 0;

    for (const task of tasks) {
      const targetPath = extractTargetPath(task.realFolderName, task.resourceName);
      if (!targetPath) {
        sentTaskRecords[task.id] = task.lastFileUpdateTime;
        saveSentTaskRecords(sentTaskRecords);
        continue;
      }

      const oldTime = sentTaskRecords[task.id];
      const newTime = task.lastFileUpdateTime;

      // 任务未更新则跳过
      if (oldTime !== undefined && oldTime === newTime) {
        continue;
      }

      // 新任务/更新任务加入队列
      if (!pendingRenameTasks.has(task.id)) {
        pendingRenameTasks.set(task.id, {
          ...task,
          targetPath: targetPath,
          pushType: oldTime === undefined ? '首次' : '更新'
        });
        console.log(`[${getShanghaiTime()}] 📥 发现${pendingRenameTasks.get(task.id).pushType}任务，等待重命名
├─ 任务ID：${task.id}
├─ 资源名称：${task.resourceName}
├─ 截取路径：${targetPath}`);
      }
    }

  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 轮询Tasks失败:`, error.message);
  }
}

// ===== 推送执行函数（无delay字段）=====
async function doPush(task) {
  try {
    const pushData = {
      strmtask: CONFIG.strmTasks.join(','),
      event: 'cs_strm',
      savepath: task.targetPath
    };

    await axios.post(CONFIG.targetWebhook, pushData, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });

    // 更新推送记录
    sentTaskRecords[task.id] = task.lastFileUpdateTime;
    saveSentTaskRecords(sentTaskRecords);

    console.log(`[${getShanghaiTime()}] ✅ ${task.pushType}推送成功（1分钟内最后一次）
├─ 任务ID：${task.id}
├─ 原始路径：${task.realFolderName}
├─ 资源名称：${task.resourceName}
├─ 推送路径：${task.targetPath}`);
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 推送失败:`, error.message);
    console.error(`[${getShanghaiTime()}] ❌ 推送错误详情:`, error.response?.data || error.stack);
  }
}

// ===== 步骤2：轮询Logs - 双重验证+同路径去重+延迟推送 =====
async function pollLogsAndPush() {
  try {
    if (pendingRenameTasks.size === 0) return;

    const res = await axios.get(CONFIG.logsApi, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });
    if (!res.data) return;

    const logText = Array.isArray(res.data) ? res.data.join('') : res.data.toString();

    // 1. 提取「任务[xxx]执行完成」的任务名 → 用于匹配任务是否执行完成
    const executedTaskReg = /任务\[([^\]]+)\]执行完成/g;
    const executedTasks = new Set();
    let execMatch;
    while ((execMatch = executedTaskReg.exec(logText)) !== null) {
      executedTasks.add(execMatch[1].trim());
    }

    // 2. 提取「xxx自动重命名完成」的完整名称 → 用于匹配重命名是否完成（保留(根)）
    const renameDoneReg = /(.+?)自动重命名完成/g;
    const renamedTasks = new Set();
    let renameMatch;
    while ((renameMatch = renameDoneReg.exec(logText)) !== null) {
      renamedTasks.add(renameMatch[1].trim());
    }

    // 3. 遍历待重命名队列，双重精准匹配
    for (const [taskId, task] of pendingRenameTasks.entries()) {
      // 任务执行完成匹配：去(根)的名称
      const taskNameWithoutRoot = task.resourceName.trim().replace(/\(根\)/g, '');
      // 重命名完成匹配：带(根)的原始名称（全等匹配）
      const taskNameWithRoot = task.resourceName.trim();

      // 条件1：任务名（去根）出现在执行完成日志中
      const isTaskExecuted = Array.from(executedTasks).some(execName =>
        execName.includes(taskNameWithoutRoot) || taskNameWithoutRoot.includes(execName)
      );

      // 条件2：原始名（带根）与重命名日志完全匹配
      const isRenameDone = renamedTasks.has(taskNameWithRoot);

      // 双重条件满足 → 进入延迟推送流程
      if (isTaskExecuted && isRenameDone) {
        const targetPath = task.targetPath;

        // 同路径去重：清除旧定时器，覆盖为最后一个任务
        if (delayedPushCache.has(targetPath)) {
          const oldCache = delayedPushCache.get(targetPath);
          clearTimeout(oldCache.timer);
          console.log(`[${getShanghaiTime()}] ⏳ 路径${targetPath}已有待推送任务，更新为最后一次（任务ID：${taskId}）`);
        }

        // 设置1分钟延迟定时器
        const timer = setTimeout(() => {
          doPush(task);
          delayedPushCache.delete(targetPath);
          pendingRenameTasks.delete(taskId);
        }, CONFIG.dedupeWindow);

        // 存入缓存
        delayedPushCache.set(targetPath, { task, timer });
        pendingRenameTasks.delete(taskId);
        console.log(`[${getShanghaiTime()}] 🎯 任务${taskId}匹配成功，进入1分钟延迟推送`);
      }
    }

  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 轮询Logs/推送失败:`, error.message);
  }
}

// ===== 合并轮询流程 =====
async function runPolling() {
  await pollTasks();
  await pollLogsAndPush();
}

// ===== 脚本启动 =====
checkRequiredEnv();
console.log(`[${getShanghaiTime()}] 🚀 脚本启动成功
├─ 轮询间隔：${CONFIG.pollInterval}秒
├─ 流程：发现任务→等待重命名→1分钟去重后推送 ✅
├─ 去重窗口期：${CONFIG.dedupeWindow / 1000}秒`);
runPolling();
setInterval(runPolling, CONFIG.pollInterval * 1000);

// ===== 脚本停止：清理定时器 =====
process.on('SIGINT', () => {
  for (const [_, cache] of delayedPushCache) {
    clearTimeout(cache.timer);
  }
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止（已清除${delayedPushCache.size}个待推送定时器）`);
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const [_, cache] of delayedPushCache) {
    clearTimeout(cache.timer);
  }
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止（已清除${delayedPushCache.size}个待推送定时器）`);
  process.exit(0);
});
