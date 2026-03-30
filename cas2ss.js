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
  persistFile: path.join(__dirname, 'data/sent-tasks.json')
};

const TIME_WINDOW_SECONDS = 120;

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
    fs.writeFileSync(CONFIG.persistFile, '{}', 'utf8');
    return {};
  }
}

function saveSentTaskRecords(records) {
  try {
    fs.writeFileSync(CONFIG.persistFile, JSON.stringify(records, null, 2), 'utf8');
  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 保存任务记录失败:`, error.message);
  }
}

let sentTaskRecords = initSentTaskRecords();

let lastNoTaskLogAt = 0;
const NO_TASK_LOG_INTERVAL = 60 * 1000;

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

const waitingQueue = new Map();

function chainGroupTasks(tasks) {
  const sorted = [...tasks].sort((a, b) => 
    new Date(a.lastCheckTime) - new Date(b.lastCheckTime)
  );
  
  const groups = [];
  for (const task of sorted) {
    const checkTime = new Date(task.lastCheckTime).getTime();
    
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1];
      const lastTask = lastGroup.tasks[lastGroup.tasks.length - 1];
      const lastCheckTime = new Date(lastTask.lastCheckTime).getTime();
      const timeDiff = checkTime - lastCheckTime;
      
      if (timeDiff < TIME_WINDOW_SECONDS * 1000) {
        lastGroup.tasks.push(task);
        lastGroup.lastCheckTime = checkTime;
        continue;
      }
    }
    
    groups.push({
      tasks: [task],
      firstCheckTime: checkTime,
      lastCheckTime: checkTime
    });
  }
  
  return groups;
}

async function executePush(targetPath, tasks) {
  const groups = chainGroupTasks(tasks);
  
  for (const group of groups) {
    const taskCount = group.tasks.length;
    
    const pushData = {
      strmtask: CONFIG.strmTasks.join(','),
      event: 'cs_strm',
      savepath: targetPath
    };

    try {
      await axios.post(CONFIG.targetWebhook, pushData, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });

      for (const task of group.tasks) {
        sentTaskRecords[task.id] = task.lastFileUpdateTime;
      }
      saveSentTaskRecords(sentTaskRecords);

      if (taskCount === 1) {
        const task = group.tasks[0];
        console.log(`[${getShanghaiTime()}] ✅ 推送成功
├─ 任务ID：${task.id}
├─ 资源名称：${task.resourceName}
├─ 推送路径：${targetPath}
└─ 推送方式：单独推送`);
      } else {
        const resourceNames = group.tasks.map(t => t.resourceName).join(',');
        const taskIds = group.tasks.map(t => t.id).join(',');
        console.log(`[${getShanghaiTime()}] ✅ 推送成功（合并推送）
├─ 合并任务数：${taskCount}个
├─ 任务ID列表：${taskIds}
├─ 资源名称：${resourceNames}
├─ 推送路径：${targetPath}
└─ 时间跨度：${Math.round((group.lastCheckTime - group.firstCheckTime) / 1000)}秒`);
      }
    } catch (pushError) {
      console.error(`[${getShanghaiTime()}] ❌ 推送失败 [${targetPath}]:`, pushError.message);
    }
  }
  
  waitingQueue.delete(targetPath);
}

function canJoinChain(newTask, existingTasks) {
  if (existingTasks.length === 0) return true;
  
  const sorted = [...existingTasks, newTask].sort((a, b) => 
    new Date(a.lastCheckTime) - new Date(b.lastCheckTime)
  );
  
  const newIndex = sorted.findIndex(t => t.id === newTask.id);
  
  if (newIndex > 0) {
    const prevTask = sorted[newIndex - 1];
    const prevCheckTime = new Date(prevTask.lastCheckTime).getTime();
    const newCheckTime = new Date(newTask.lastCheckTime).getTime();
    if (newCheckTime - prevCheckTime >= TIME_WINDOW_SECONDS * 1000) {
      return false;
    }
  }
  
  if (newIndex < sorted.length - 1) {
    const nextTask = sorted[newIndex + 1];
    const nextCheckTime = new Date(nextTask.lastCheckTime).getTime();
    const newCheckTime = new Date(newTask.lastCheckTime).getTime();
    if (nextCheckTime - newCheckTime >= TIME_WINDOW_SECONDS * 1000) {
      return false;
    }
  }
  
  return true;
}

// 判断是否过期（超过120秒）
function isExpired(task) {
  const checkTime = new Date(task.lastCheckTime).getTime();
  const now = Date.now();
  return (now - checkTime) >= TIME_WINDOW_SECONDS * 1000;
}

function addToWaitingQueue(task, targetPath) {
  const expired = isExpired(task);
  
  // 队列不存在
  if (!waitingQueue.has(targetPath)) {
    // 过期任务：立即推送
    if (expired) {
      console.log(`[${getShanghaiTime()}] ⚡ 检测到过期任务，立即推送`);
      executePush(targetPath, [task]);
      return true;
    }
    
    // 新任务：创建队列，等待120秒
    waitingQueue.set(targetPath, {
      tasks: [task],
      timer: setTimeout(async () => {
        const currentQueue = waitingQueue.get(targetPath);
        if (currentQueue && currentQueue.tasks.length > 0) {
          await executePush(targetPath, currentQueue.tasks);
        }
      }, TIME_WINDOW_SECONDS * 1000)
    });
    return true;
  }
  
  const queue = waitingQueue.get(targetPath);
  
  // 任务已在队列中
  if (queue.tasks.some(t => t.id === task.id)) {
    return false;
  }
  
  // 过期任务：立即推送整个队列
  if (expired) {
    console.log(`[${getShanghaiTime()}] ⚡ 检测到过期任务，立即推送队列`);
    clearTimeout(queue.timer);
    queue.tasks.push(task);
    executePush(targetPath, queue.tasks);
    return true;
  }
  
  // 链式判断
  if (!canJoinChain(task, queue.tasks)) {
    console.log(`[${getShanghaiTime()}] 🔄 路径 ${targetPath} 新任务超出窗口，先推送现有任务`);
    
    clearTimeout(queue.timer);
    executePush(targetPath, [...queue.tasks]);
    
    waitingQueue.set(targetPath, {
      tasks: [task],
      timer: setTimeout(async () => {
        const currentQueue = waitingQueue.get(targetPath);
        if (currentQueue && currentQueue.tasks.length > 0) {
          await executePush(targetPath, currentQueue.tasks);
        }
      }, TIME_WINDOW_SECONDS * 1000)
    });
    return true;
  }
  
  // 加入队列（不重置定时器）
  queue.tasks.push(task);
  return true;
}

async function runPolling() {
  try {
    const res = await axios.get(CONFIG.projectApi, {
      headers: { 'x-api-key': CONFIG.apiKey }
    });

    if (!res.data?.success || !Array.isArray(res.data.data)) {
      const now = Date.now();
      if (now - lastNoTaskLogAt >= NO_TASK_LOG_INTERVAL) {
        console.log(`[${getShanghaiTime()}] ⏳ 暂无新任务`);
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

    let newTaskCount = 0;
    for (const task of tasks) {
      const targetPath = extractTargetPath(task.realFolderName, task.resourceName);
      const oldTime = sentTaskRecords[task.id];
      const newTime = task.lastFileUpdateTime;
      
      if (!targetPath) {
        if (oldTime === undefined || oldTime !== newTime) {
          sentTaskRecords[task.id] = newTime;
        }
        continue;
      }
      
      if (oldTime !== undefined && oldTime === newTime) {
        continue;
      }
      
      if (addToWaitingQueue(task, targetPath)) {
        newTaskCount++;
      }
    }
    
    saveSentTaskRecords(sentTaskRecords);

    if (newTaskCount > 0) {
      console.log(`[${getShanghaiTime()}] 📥 新增 ${newTaskCount} 个任务到等待队列`);
    }

  } catch (error) {
    console.error(`[${getShanghaiTime()}] ❌ 错误：${error.message}`);
  }
}

checkRequiredEnv();
console.log(`[${getShanghaiTime()}] 🚀 脚本启动成功
├─ 轮询间隔：${CONFIG.pollInterval}秒
└─ 时间窗口：${TIME_WINDOW_SECONDS}秒（过期任务立即推送）`);
runPolling();
setInterval(runPolling, CONFIG.pollInterval * 1000);

process.on('SIGINT', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止`);
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log(`\n[${getShanghaiTime()}] 📤 脚本停止`);
  process.exit(0);
});
