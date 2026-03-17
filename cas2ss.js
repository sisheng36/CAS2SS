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

// ===== 🔥 改造1：持久化改为存储{taskId: lastFileUpdateTime}，兼容旧数据 =====
function initSentTaskIds() {
  try {
    const dataDir = path.dirname(CONFIG.persistFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(CONFIG.persistFile)) {
      const content = fs.readFileSync(CONFIG.persistFile, 'utf8');
      const oldData = JSON.parse(content || '[]');
      // 兼容旧的Set数组格式，转为{taskId: lastFileUpdateTime}对象
      if (Array.isArray(oldData)) {
        const newData = {};
        oldData.forEach(taskId => newData[taskId] = ''); // 旧数据无时间，设为空
        saveSentTaskIds(newData);
        return newData;
      }
      return oldData || {};
    } else {
      fs.writeFileSync(CONFIG.persistFile, '{}', 'utf8');
      return {};
    }
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 初始化任务ID失败:`, error.message);
    return {};
  }
}

function saveSentTaskIds(taskRecords) {
  try {
    const data = JSON.stringify(taskRecords, null, 2); // 格式化保存，方便查看
    fs.writeFileSync(CONFIG.persistFile, data, 'utf8');
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 保存任务ID失败:`, error.message);
  }
}

// 🔥 全局变量改为对象：{taskId: lastFileUpdateTime}
let sentTaskRecords = initSentTaskIds();

// ===== 🔥 改造2：添加日志频率控制（1分钟仅打印一次无任务日志）=====
let lastNoTaskLogTime = 0; // 最后一次打印无任务日志的时间戳
const NO_TASK_LOG_INTERVAL = 60 * 1000; // 60秒 = 1分钟

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

// ===== 核心轮询逻辑（🔥 新增lastFileUpdateTime判断 + 日志频率控制）=====
async function runPolling() {
  try {
    const res = await axios.get(CONFIG.projectApi, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });

    if (!res.data?.success || !Array.isArray(res.data.data)) {
      // 🔥 仅当距离上次打印超过1分钟时，才输出无数据日志
      const now = Date.now();
      if (now - lastNoTaskLogTime >= NO_TASK_LOG_INTERVAL) {
        console.log(`[${getShanghaiTime()}] API无有效数据`);
        lastNoTaskLogTime = now; // 更新最后打印时间
      }
      return;
    }

    // 🔥 筛选条件新增：必须有lastFileUpdateTime字段
    const validTasks = res.data.data.filter(task => 
      task.status === CONFIG.filterStatus && 
      task.realFolderName &&
      task.lastFileUpdateTime // 确保有文件更新时间
    );

    if (validTasks.length === 0) {
      // 🔥 仅当距离上次打印超过1分钟时，才输出无任务日志
      const now = Date.now();
      if (now - lastNoTaskLogTime >= NO_TASK_LOG_INTERVAL) {
        console.log(`[${getShanghaiTime()}] ⏳ 暂无新任务`);
        lastNoTaskLogTime = now;
      }
      return;
    }

    // 🔥 有有效任务时，重置日志计时（下次无任务时重新开始1分钟计数）
    lastNoTaskLogTime = 0;

    for (const task of validTasks) {
      const targetPath = extractTargetPath(task.realFolderName, task.resourceName);
      if (!targetPath) {
        console.log(`[${getShanghaiTime()}] ⏭️ 任务${task.id}无有效路径（resourceName: ${task.resourceName}），跳过推送`);
        // 🔥 记录该任务的更新时间，避免重复判断
        sentTaskRecords[task.id] = task.lastFileUpdateTime;
        saveSentTaskIds(sentTaskRecords);
        continue;
      }

      // 🔥 核心判断：是否需要推送（首次推送 或 文件更新）
      const needPush = !sentTaskRecords.hasOwnProperty(task.id) // 无记录 → 首次推送
        || sentTaskRecords[task.id] !== task.lastFileUpdateTime; // 有记录但时间变化 → 更新推送

      if (!needPush) {
        // 🔥 文件无更新时，仅打印一次（可选：注释掉该行则无更新时不打印）
        console.log(`[${getShanghaiTime()}] ⏭️ 任务${task.id}文件无更新，跳过推送`);
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

      // 🔥 更新该任务的最后推送时间
      sentTaskRecords[task.id] = task.lastFileUpdateTime;
      saveSentTaskIds(sentTaskRecords);
      
      // 🔥 区分首次/更新推送日志
      const pushType = !sentTaskRecords.hasOwnProperty(task.id) ? '首次' : '更新';
      console.log(`[${getShanghaiTime()}] ✅ ${pushType}推送成功
├─ 任务ID：${task.id}
├─ 原始路径：${task.realFolderName}
├─ 资源名称：${task.resourceName}
├─ 推送路径：${targetPath}
├─ 延迟时间：${CONFIG.delay}秒
├─ 文件更新时间：${task.lastFileUpdateTime}`);
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
├─ Webhook地址：${CONFIG.targetWebhook}
├─ 推送规则：首次推送 + 文件更新时重新推送
├─ 日志规则：无任务/无数据日志1分钟仅打印一次`);
runPolling();
setInterval(runPolling, CONFIG.pollInterval * 1000);

// ===== 优雅停止（替换时间输出）=====
process.on('SIGINT', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止，保存任务ID...`);
  saveSentTaskIds(sentTaskRecords);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止，保存任务ID...`);
  saveSentTaskIds(sentTaskRecords);
  process.exit(0);
});
