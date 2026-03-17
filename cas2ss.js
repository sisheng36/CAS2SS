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

// ===== 新增：获取上海时间格式化字符串 =====
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

// ===== 路径截取逻辑（保持不变）=====
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

// ===== 持久化函数（保持不变）=====
function initSentTaskIds() {
  try {
    const dataDir = path.dirname(CONFIG.persistFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(CONFIG.persistFile)) {
      const content = fs.readFileSync(CONFIG.persistFile, 'utf8');
      return new Set(JSON.parse(content || '[]'));
    } else {
      fs.writeFileSync(CONFIG.persistFile, '[]', 'utf8');
      return new Set();
    }
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 初始化任务ID失败:`, error.message);
    return new Set();
  }
}

function saveSentTaskIds(taskIds) {
  try {
    const data = JSON.stringify(Array.from(taskIds));
    fs.writeFileSync(CONFIG.persistFile, data, 'utf8');
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 保存任务ID失败:`, error.message);
  }
}

let sentTaskIds = initSentTaskIds();

// ===== 必填项检查（保持不变）=====
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
  if (CONFIG.pollInterval <= 0) {
    console.error(`[${getShanghaiTime()}] ❌ POLL_INTERVAL 必须大于0`);
    process.exit(1);
  }
  if (CONFIG.delay < 0) {
    console.error(`[${getShanghaiTime()}] ❌ DELAY 必须≥0`);
    process.exit(1);
  }
}

// ===== 核心轮询逻辑（替换所有时间输出）=====
async function runPolling() {
  try {
    const res = await axios.get(CONFIG.projectApi, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });

    if (!res.data?.success || !Array.isArray(res.data.data)) {
      console.log(`[${getShanghaiTime()}] API无有效数据`);
      return;
    }

    const validTasks = res.data.data.filter(task => 
      task.status === CONFIG.filterStatus && 
      !sentTaskIds.has(task.id) && 
      task.realFolderName
    );

    if (validTasks.length === 0) {
      console.log(`[${getShanghaiTime()}] ⏳ 暂无新任务`);
      return;
    }

    for (const task of validTasks) {
      const targetPath = extractTargetPath(task.realFolderName, task.resourceName);
      if (!targetPath) {
        console.log(`[${getShanghaiTime()}] ⏭️ 任务${task.id}无有效路径（resourceName: ${task.resourceName}），跳过推送`);
        sentTaskIds.add(task.id);
        saveSentTaskIds(sentTaskIds);
        continue;
      }

      const pushData = {
        strmtask: CONFIG.strmTasks.join(','),
        event: 'cs_strm',
        savepath: targetPath,
        delay: CONFIG.delay
      };

      await axios.post(CONFIG.targetWebhook, pushData, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });

      sentTaskIds.add(task.id);
      saveSentTaskIds(sentTaskIds);
      console.log(`[${getShanghaiTime()}] ✅ 推送成功
├─ 任务ID：${task.id}
├─ 原始路径：${task.realFolderName}
├─ 资源名称：${task.resourceName}
├─ 推送路径：${targetPath}
├─ 延迟时间：${CONFIG.delay}秒`);
    }

  } catch (error) {
    const now = getShanghaiTime();
    if (error.response?.status === 401) {
      console.error(`[${now}] ❌ API_KEY 错误`);
    } else if (error.response?.status === 404) {
      console.error(`[${now}] ❌ PROJECT_API 地址无效`);
    } else {
      console.error(`[${now}] ❌ 错误：${error.message}`);
    }
  }
}

// ===== 启动流程（替换时间输出）=====
checkRequiredEnv();
console.log(`[${getShanghaiTime()}] 🚀 脚本启动成功
├─ 监控任务：${CONFIG.strmTasks.join(',')}
├─ 轮询间隔：${CONFIG.pollInterval}秒
├─ 推送延迟：${CONFIG.delay}秒
├─ API地址：${CONFIG.projectApi}
├─ Webhook地址：${CONFIG.targetWebhook}`);
runPolling();
setInterval(runPolling, CONFIG.pollInterval * 1000);

// ===== 优雅停止（替换时间输出）=====
process.on('SIGINT', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止，保存任务ID...`);
  saveSentTaskIds(sentTaskIds);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止，保存任务ID...`);
  saveSentTaskIds(sentTaskIds);
  process.exit(0);
});
