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
  dedupeWindow: 60 * 1000 // 1分钟去重窗口期
  // ===== 已删除：delay配置 =====
};

// ===== 上海时间（不变）=====
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

// ===== 路径截取（完全不变）=====
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

// ===== 持久化（完全不变）=====
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

let sentTaskRecords = initSentTaskRecords();
let pendingRenameTasks = new Map();
let delayedPushCache = new Map();

// ===== 日志频率控制（不变）=====
let lastNoTaskLogAt = 0;
const NO_TASK_LOG_INTERVAL = 60 * 1000;

// ===== 环境检查（已删除DELAY检查）=====
function checkRequiredEnv() {
  const required = [
    { key: 'PROJECT_API', value: CONFIG.projectApi },
    { key: 'API_KEY', value: CONFIG.apiKey },
    { key: 'TARGET_WEBHOOK', value: CONFIG.targetWebhook },
    { key: 'STRM_TASKS', value: CONFIG.strmTasks },
    { key: 'FILTER_STATUS', value: CONFIG.filterStatus },
    { key: 'POLL_INTERVAL', value: CONFIG.pollInterval }
    // ===== 已删除：DELAY环境变量检查 =====
  ];
  const missing = required.filter(item => !item.value);
  if (missing.length > 0) {
    console.error(`[${getShanghaiTime()}] ❌ 缺少必填环境变量：`);
    missing.forEach(item => console.error(`   - ${item.key}`));
    process.exit(1);
  }
}

// ===== 步骤1：轮询tasks（不变，仅删除delay相关日志）=====
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

      if (oldTime !== undefined && oldTime === newTime) {
        continue;
      }

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
        // ===== 已删除：延迟时间相关日志 =====
      }
    }

  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 轮询Tasks失败:`, error.message);
  }
}

// ===== 推送函数（已删除delay字段）=====
async function doPush(task) {
  try {
    const pushData = {
      strmtask: CONFIG.strmTasks.join(','),
      event: 'cs_strm',
      savepath: task.targetPath
      // ===== 已删除：delay字段 =====
    };

    await axios.post(CONFIG.targetWebhook, pushData, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });

    sentTaskRecords[task.id] = task.lastFileUpdateTime;
    saveSentTaskRecords(sentTaskRecords);

    console.log(`[${getShanghaiTime()}] ✅ ${task.pushType}推送成功（1分钟内最后一次）
├─ 任务ID：${task.id}
├─ 原始路径：${task.realFolderName}
├─ 资源名称：${task.resourceName}
├─ 推送路径：${task.targetPath}`);
    // ===== 已删除：延迟时间日志 =====
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 推送失败:`, error.message);
  }
}

// ===== 步骤2：轮询Logs+去重（不变）=====
async function pollLogsAndPush() {
  try {
    if (pendingRenameTasks.size === 0) return;

    const res = await axios.get(CONFIG.logsApi, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });
    if (!res.data) return;

    const logText = Array.isArray(res.data) ? res.data.join('') : res.data.toString();
    const isGlobalRenameDone = logText.includes('自动重命名完成');
    if (!isGlobalRenameDone) return;

    const taskNameReg = /任务\[([^\]]+)\]/g;
    const logTaskNames = new Set();
    let match;
    while ((match = taskNameReg.exec(logText)) !== null) {
      logTaskNames.add(match[1].trim());
    }

    for (const [taskId, task] of pendingRenameTasks.entries()) {
      const taskMatchName = task.resourceName.trim().replace(/\(根\)/g, '');
      const isTaskRenameDone = Array.from(logTaskNames).some(logName => 
        logName.includes(taskMatchName) || taskMatchName.includes(logName)
      );

      if (isTaskRenameDone) {
        const targetPath = task.targetPath;

        if (delayedPushCache.has(targetPath)) {
          const oldCache = delayedPushCache.get(targetPath);
          clearTimeout(oldCache.timer);
          console.log(`[${getShanghaiTime()}] ⏳ 路径${targetPath}已有待推送任务，更新为最后一次（任务ID：${taskId}）`);
        }

        const timer = setTimeout(() => {
          doPush(task);
          delayedPushCache.delete(targetPath);
          pendingRenameTasks.delete(taskId);
        }, CONFIG.dedupeWindow);

        delayedPushCache.set(targetPath, {
          task: task,
          timer: timer
        });

        pendingRenameTasks.delete(taskId);
      }
    }

  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 轮询Logs/推送失败:`, error.message);
  }
}

// ===== 合并轮询（不变）=====
async function runPolling() {
  await pollTasks();
  await pollLogsAndPush();
}

// ===== 启动（已删除日志API+delay相关打印）=====
checkRequiredEnv();
console.log(`[${getShanghaiTime()}] 🚀 脚本启动成功
├─ 轮询间隔：${CONFIG.pollInterval}秒
├─ 流程：发现任务→等待重命名→1分钟去重后推送 ✅
├─ 去重窗口期：${CONFIG.dedupeWindow / 1000}秒`);
runPolling();
setInterval(runPolling, CONFIG.pollInterval * 1000);

// ===== 停止（不变）=====
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
