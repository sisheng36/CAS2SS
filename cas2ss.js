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
  delay: parseInt(process.env.DELAY),
  persistFile: path.join(__dirname, 'data/sent-tasks.json')
};

// ===== 上海时间 =====
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

// ===== 持久化：存储 { [task.id]: lastFileUpdateTime } =====
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

// ===== 1分钟只打一次无任务日志 =====
let lastNoTaskLogAt = 0;
const NO_TASK_LOG_INTERVAL = 60 * 1000;

// ===== 环境检查（不变）=====
function checkRequiredEnv() {
  const required = [
    { key: 'PROJECT_API', value: CONFIG.projectApi },
    { key: 'API_KEY', value: CONFIG.apiKey },
    { key: 'TARGET_WEBHOOK', value: CONFIG.targetWebhook },
    { key: 'STRM_TASKS', value: CONFIG.strmTasks },
    { key: 'FILTER_STATUS', value: CONFIG.filterStatus },
    { key: 'POLL_INTERVAL', value: CONFIG.pollInterval },
    { key: 'DELAY', value: CONFIG.delay }
  ];
  const missing = required.filter(item => !item.value);
  if (missing.length > 0) {
    console.error(`[${getShanghaiTime()}] ❌ 缺少必填环境变量：`);
    missing.forEach(item => console.error(`   - ${item.key}`));
    process.exit(1);
  }
}

// ===== 核心轮询 =====
async function runPolling() {
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

      // ——🔥 核心：id存在 && 时间没变 → 彻底静默跳过
      if (oldTime !== undefined && oldTime === newTime) {
        continue;
      }

      // ——🔥 只有：第一次 / 时间变了 才推送
      const pushData = {
        strmtask: CONFIG.strmTasks.join(','),
        event: 'cs_strm',
        savepath: targetPath,
        delay: CONFIG.delay
      };

      await axios.post(CONFIG.targetWebhook, pushData, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });

      // 记录这次的时间
      sentTaskRecords[task.id] = newTime;
      saveSentTaskRecords(sentTaskRecords);

      const type = oldTime === undefined ? '首次' : '更新';
      console.log(`[${getShanghaiTime()}] ✅ ${type}推送成功
├─ 任务ID：${task.id}
├─ 原始路径：${task.realFolderName}
├─ 资源名称：${task.resourceName}
├─ 推送路径：${targetPath}
├─ 延迟时间：${CONFIG.delay}秒`);
    }

  } catch (error) {
    const now = getShanghaiTime();
    console.error(`[${now}] ❌ 错误：${error.message}`);
  }
}

// ===== 启动 =====
checkRequiredEnv();
console.log(`[${getShanghaiTime()}] 🚀 脚本启动成功
├─ 轮询间隔：${CONFIG.pollInterval}秒
├─ 推送延迟：${CONFIG.delay}秒
├─ 已兼容 lastFileUpdateTime = null`);
runPolling();
setInterval(runPolling, CONFIG.pollInterval * 1000);

// ===== 停止 =====
process.on('SIGINT', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止`);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止`);
  process.exit(0);
});
