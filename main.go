package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 配置结构
type Config struct {
	ProjectAPI    string
	APIKey        string
	TargetWebhook string
	PollInterval  int
	StrmTasks     []string
	FilterStatus  string
	PersistFile   string
}

// 任务结构
type Task struct {
	ID                 json.Number `json:"id"`
	ResourceName       string      `json:"resourceName"`
	RealFolderName     string      `json:"realFolderName"`
	Status             string      `json:"status"`
	LastCheckTime      string      `json:"lastCheckTime"`
	LastFileUpdateTime string      `json:"lastFileUpdateTime"`
}

// API响应结构
type APIResponse struct {
	Success bool   `json:"success"`
	Data    []Task `json:"data"`
}

// 推送数据结构
type PushData struct {
	StrmTask string `json:"strmtask"`
	Event    string `json:"event"`
	SavePath string `json:"savepath"`
}

// 任务组
type TaskGroup struct {
	tasks          []Task
	firstCheckTime time.Time
	lastCheckTime  time.Time
}

// 等待队列项
type QueueItem struct {
	tasks []Task
	timer *time.Timer
	mu    sync.Mutex
}

// 全局变量
var (
	config            Config
	sentTaskRecords   = make(map[string]string)
	sentTaskRecordsMu sync.RWMutex
	waitingQueue      = make(map[string]*QueueItem)
	waitingQueueMu    sync.Mutex
	lastNoTaskLogAt   time.Time
)

const (
	timeWindowMovieSeconds   = 30
	timeWindowDefaultSeconds = 120
	noTaskLogInterval        = 60 * time.Second
)

func main() {
	loadConfig()
	checkRequiredEnv()
	initSentTaskRecords()

	fmt.Printf("[%s] 🚀 脚本启动成功\n", getShanghaiTime())
	fmt.Printf("├─ 轮询间隔：%d秒\n", config.PollInterval)
	fmt.Printf("├─ 电影路径时间窗口：%d秒\n", timeWindowMovieSeconds)
	fmt.Printf("└─ 其他路径时间窗口：%d秒（过期任务立即推送）\n", timeWindowDefaultSeconds)

	runPolling()
	ticker := time.NewTicker(time.Duration(config.PollInterval) * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		runPolling()
	}
}

func loadConfig() {
	projectAPI := os.Getenv("PROJECT_API")
	// 提前拼接路径
	projectAPI = strings.TrimSuffix(projectAPI, "/") + "/api/tasks"

	config = Config{
		ProjectAPI:    projectAPI,       // 使用拼接后的地址
		APIKey:        os.Getenv("API_KEY"),
		TargetWebhook: os.Getenv("TARGET_WEBHOOK"),
		PollInterval:  parseInt(os.Getenv("POLL_INTERVAL")),
		FilterStatus:  os.Getenv("FILTER_STATUS"),
		PersistFile:   filepath.Join(getExeDir(), "data", "sent-tasks.json"),
	}

	strmTasks := os.Getenv("STRM_TASKS")
	if strmTasks != "" {
		config.StrmTasks = strings.Split(strmTasks, ",")
	}
}

func parseInt(s string) int {
	var result int
	fmt.Sscanf(s, "%d", &result)
	return result
}

func getExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func checkRequiredEnv() {
	required := map[string]string{
		"PROJECT_API":    config.ProjectAPI,
		"API_KEY":        config.APIKey,
		"TARGET_WEBHOOK": config.TargetWebhook,
		"STRM_TASKS":     strings.Join(config.StrmTasks, ","),
		"FILTER_STATUS":  config.FilterStatus,
		"POLL_INTERVAL":  fmt.Sprintf("%d", config.PollInterval),
	}

	var missing []string
	for key, value := range required {
		if value == "" {
			missing = append(missing, key)
		}
	}

	if len(missing) > 0 {
		fmt.Printf("[%s] ❌ 缺少必填环境变量：\n", getShanghaiTime())
		for _, key := range missing {
			fmt.Printf("   - %s\n", key)
		}
		os.Exit(1)
	}
}

func getShanghaiTime() string {
	// 上海时区 UTC+8，不依赖时区数据库
	now := time.Now().UTC().Add(8 * time.Hour)
	return now.Format("2006-01-02 15:04:05")
}

func isMoviePath(targetPath string) bool {
	if targetPath == "" {
		return false
	}
	lowerPath := strings.ToLower(targetPath)
	return strings.Contains(lowerPath, "电影") || strings.Contains(lowerPath, "movie")
}

func getTimeWindowByPath(targetPath string) int {
	if isMoviePath(targetPath) {
		return timeWindowMovieSeconds
	}
	return timeWindowDefaultSeconds
}

func extractTargetPath(realFolderName, resourceName string) string {
	if realFolderName == "" || resourceName == "" {
		return ""
	}

	cleanPath := strings.Trim(realFolderName, " /")

	cleanResource := strings.Trim(resourceName, " ")
	cleanResource = strings.TrimSuffix(cleanResource, "(根)")

	pathParts := strings.Split(cleanPath, "/")
	var filteredParts []string
	for _, part := range pathParts {
		if strings.Trim(part, " ") != "" {
			filteredParts = append(filteredParts, part)
		}
	}

	if len(filteredParts) == 0 {
		return ""
	}

	resourceIndex := -1
	for i, part := range filteredParts {
		if strings.Contains(part, cleanResource) {
			resourceIndex = i
			break
		}
	}

	if resourceIndex == -1 {
		return ""
	}

	targetParts := filteredParts[:resourceIndex+1]
	if len(targetParts) > 0 {
		return "/" + strings.Join(targetParts, "/")
	}
	return ""
}

func initSentTaskRecords() {
	dataDir := filepath.Dir(config.PersistFile)
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		fmt.Printf("[%s] ❌ 创建数据目录失败: %v\n", getShanghaiTime(), err)
		return
	}

	data, err := os.ReadFile(config.PersistFile)
	if err != nil {
		if os.IsNotExist(err) {
			os.WriteFile(config.PersistFile, []byte("{}"), 0644)
		}
		return
	}

	if len(data) == 0 {
		data = []byte("{}")
	}

	var records map[string]string
	if err := json.Unmarshal(data, &records); err != nil {
		fmt.Printf("[%s] ❌ 解析任务记录失败: %v\n", getShanghaiTime(), err)
		os.WriteFile(config.PersistFile, []byte("{}"), 0644)
		return
	}

	sentTaskRecords = records
}

func saveSentTaskRecords() {
	sentTaskRecordsMu.RLock()
	data, err := json.MarshalIndent(sentTaskRecords, "", "  ")
	sentTaskRecordsMu.RUnlock()

	if err != nil {
		fmt.Printf("[%s] ❌ 序列化任务记录失败: %v\n", getShanghaiTime(), err)
		return
	}

	os.WriteFile(config.PersistFile, data, 0644)
}

func runPolling() {
	req, err := http.NewRequest("GET", config.ProjectAPI, nil)
	if err != nil {
		fmt.Printf("[%s] ❌ 创建请求失败: %v\n", getShanghaiTime(), err)
		return
	}
	req.Header.Set("x-api-key", config.APIKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[%s] ❌ 请求失败: %v\n", getShanghaiTime(), err)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Printf("[%s] ❌ 读取响应失败: %v\n", getShanghaiTime(), err)
		return
	}

	var apiResp APIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		fmt.Printf("[%s] ❌ 解析响应失败: %v\n", getShanghaiTime(), err)
		return
	}

	if !apiResp.Success || len(apiResp.Data) == 0 {
		if time.Since(lastNoTaskLogAt) >= noTaskLogInterval {
			fmt.Printf("[%s] ⏳ 暂无新任务\n", getShanghaiTime())
			lastNoTaskLogAt = time.Now()
		}
		return
	}

	lastNoTaskLogAt = time.Time{}

	var filteredTasks []Task
	for _, task := range apiResp.Data {
		if task.RealFolderName != "" {
			filteredTasks = append(filteredTasks, task)
		}
	}

	if len(filteredTasks) == 0 {
		if time.Since(lastNoTaskLogAt) >= noTaskLogInterval {
			fmt.Printf("[%s] ⏳ 暂无新任务\n", getShanghaiTime())
			lastNoTaskLogAt = time.Now()
		}
		return
	}

for _, task := range filteredTasks {
	targetPath := extractTargetPath(task.RealFolderName, task.ResourceName)

	sentTaskRecordsMu.RLock()
	oldTime, exists := sentTaskRecords[task.ID.String()]
	sentTaskRecordsMu.RUnlock()

	if targetPath == "" {
		if !exists || oldTime != task.LastFileUpdateTime {
			sentTaskRecordsMu.Lock()
			sentTaskRecords[task.ID.String()] = task.LastFileUpdateTime
			sentTaskRecordsMu.Unlock()
		}
		continue
	}

	if exists && oldTime == task.LastFileUpdateTime {
		continue
	}

	if addToWaitingQueue(task, targetPath) {
		fmt.Printf("[%s] 📥 新增任务到等待队列：%s\n", getShanghaiTime(), task.ResourceName)
	}
}

	saveSentTaskRecords()
}

func addToWaitingQueue(task Task, targetPath string) bool {
	timeWindow := getTimeWindowByPath(targetPath)
	expired := isExpired(task, targetPath)

	waitingQueueMu.Lock()
	defer waitingQueueMu.Unlock()

	// 队列不存在
	if _, exists := waitingQueue[targetPath]; !exists {
		// 过期任务：立即推送
		if expired {
			fmt.Printf("[%s] ⚡ 检测到过期任务，立即推送\n", getShanghaiTime())
			go executePush(targetPath, []Task{task})
			return true
		}

		// 新任务：创建队列
		item := &QueueItem{
			tasks: []Task{task},
		}
		item.timer = time.AfterFunc(time.Duration(timeWindow)*time.Second, func() {
			waitingQueueMu.Lock()
			if currentQueue, ok := waitingQueue[targetPath]; ok && len(currentQueue.tasks) > 0 {
				go executePush(targetPath, currentQueue.tasks)
			}
			delete(waitingQueue, targetPath)
			waitingQueueMu.Unlock()
		})
		waitingQueue[targetPath] = item
		return true
	}

	queue := waitingQueue[targetPath]
	queue.mu.Lock()
	defer queue.mu.Unlock()

	// 任务已在队列中
	for _, t := range queue.tasks {
		if t.ID.String() == task.ID.String() {
			return false
		}
	}

	// 过期任务：立即推送整个队列
	if expired {
		fmt.Printf("[%s] ⚡ 检测到过期任务，立即推送队列\n", getShanghaiTime())
		queue.timer.Stop()
		queue.tasks = append(queue.tasks, task)
		go executePush(targetPath, queue.tasks)
		delete(waitingQueue, targetPath)
		return true
	}

	// 链式判断
	if !canJoinChain(task, queue.tasks, targetPath) {
		fmt.Printf("[%s] 🔄 路径 %s 新任务超出窗口，先推送现有任务\n", getShanghaiTime(), targetPath)

		queue.timer.Stop()
		go executePush(targetPath, append([]Task{}, queue.tasks...))

		queue.tasks = []Task{task}
		queue.timer = time.AfterFunc(time.Duration(timeWindow)*time.Second, func() {
			waitingQueueMu.Lock()
			if currentQueue, ok := waitingQueue[targetPath]; ok && len(currentQueue.tasks) > 0 {
				go executePush(targetPath, currentQueue.tasks)
			}
			delete(waitingQueue, targetPath)
			waitingQueueMu.Unlock()
		})
		return true
	}

	// 加入队列
	queue.tasks = append(queue.tasks, task)
	return true
}

func isExpired(task Task, targetPath string) bool {
	timeWindow := getTimeWindowByPath(targetPath)
	checkTime, err := time.Parse(time.RFC3339, task.LastCheckTime)
	if err != nil {
		checkTime = time.Now()
	}
	return time.Since(checkTime) >= time.Duration(timeWindow)*time.Second
}

func canJoinChain(newTask Task, existingTasks []Task, targetPath string) bool {
	if len(existingTasks) == 0 {
		return true
	}

	timeWindow := getTimeWindowByPath(targetPath)
	allTasks := append(existingTasks, newTask)

	// 按时间排序
	sortTasksByTime(allTasks)

	newIndex := -1
	for i, t := range allTasks {
		if t.ID.String() == newTask.ID.String() {
			newIndex = i
			break
		}
	}

	newCheckTime, _ := time.Parse(time.RFC3339, newTask.LastCheckTime)

	// 检查与前一个任务的时间差
	if newIndex > 0 {
		prevTask := allTasks[newIndex-1]
		prevCheckTime, _ := time.Parse(time.RFC3339, prevTask.LastCheckTime)
		if newCheckTime.Sub(prevCheckTime) >= time.Duration(timeWindow)*time.Second {
			return false
		}
	}

	// 检查与后一个任务的时间差
	if newIndex < len(allTasks)-1 {
		nextTask := allTasks[newIndex+1]
		nextCheckTime, _ := time.Parse(time.RFC3339, nextTask.LastCheckTime)
		if nextCheckTime.Sub(newCheckTime) >= time.Duration(timeWindow)*time.Second {
			return false
		}
	}

	return true
}

func sortTasksByTime(tasks []Task) {
	for i := 0; i < len(tasks)-1; i++ {
		for j := i + 1; j < len(tasks); j++ {
			time1, _ := time.Parse(time.RFC3339, tasks[i].LastCheckTime)
			time2, _ := time.Parse(time.RFC3339, tasks[j].LastCheckTime)
			if time2.Before(time1) {
				tasks[i], tasks[j] = tasks[j], tasks[i]
			}
		}
	}
}

func chainGroupTasks(tasks []Task, targetPath string) []TaskGroup {
	timeWindow := getTimeWindowByPath(targetPath)

	sortedTasks := make([]Task, len(tasks))
	copy(sortedTasks, tasks)
	sortTasksByTime(sortedTasks)

	var groups []TaskGroup

	for _, task := range sortedTasks {
		checkTime, _ := time.Parse(time.RFC3339, task.LastCheckTime)

		if len(groups) > 0 {
			lastGroup := &groups[len(groups)-1]
			timeDiff := checkTime.Sub(lastGroup.lastCheckTime)

			if timeDiff < time.Duration(timeWindow)*time.Second {
				lastGroup.tasks = append(lastGroup.tasks, task)
				lastGroup.lastCheckTime = checkTime
				continue
			}
		}

		groups = append(groups, TaskGroup{
			tasks:          []Task{task},
			firstCheckTime: checkTime,
			lastCheckTime:  checkTime,
		})
	}

	return groups
}

func executePush(targetPath string, tasks []Task) {
	groups := chainGroupTasks(tasks, targetPath)

	for _, group := range groups {
		taskCount := len(group.tasks)

		pushData := PushData{
			StrmTask: strings.Join(config.StrmTasks, ","),
			Event:    "cs_strm",
			SavePath: targetPath,
		}

		jsonData, _ := json.Marshal(pushData)

		req, _ := http.NewRequest("POST", config.TargetWebhook, strings.NewReader(string(jsonData)))
		req.Header.Set("Content-Type", "application/json; charset=utf-8")

		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)

		if err != nil {
			fmt.Printf("[%s] ❌ 推送失败 [%s]: %v\n", getShanghaiTime(), targetPath, err)
			continue
		}
		resp.Body.Close()

		// 更新已发送记录
		for _, task := range group.tasks {
			sentTaskRecordsMu.Lock()
			sentTaskRecords[task.ID.String()] = task.LastFileUpdateTime
			sentTaskRecordsMu.Unlock()
		}
		saveSentTaskRecords()

		// 输出日志
		if taskCount == 1 {
			task := group.tasks[0]
			fmt.Printf("[%s] ✅ 推送成功\n", getShanghaiTime())
			fmt.Printf("├─ 任务ID：%s\n", task.ID.String())
			fmt.Printf("├─ 资源名称：%s\n", task.ResourceName)
			fmt.Printf("├─ 推送路径：%s\n", targetPath)
			fmt.Println("└─ 推送方式：单独推送")
		} else {
			taskIds := make([]string, len(group.tasks))
			for i, t := range group.tasks {
				taskIds[i] = t.ID.String()
			}

			fmt.Printf("[%s] ✅ 推送成功（合并推送）\n", getShanghaiTime())
			fmt.Printf("├─ 合并任务数：%d个\n", taskCount)
			fmt.Printf("├─ 任务ID列表：%s\n", strings.Join(taskIds, ","))
			fmt.Println("├─ 资源名称：")
			for i, t := range group.tasks {
				if i == len(group.tasks)-1 {
					fmt.Printf("│  └─ %s\n", t.ResourceName)
				} else {
					fmt.Printf("│  ├─ %s\n", t.ResourceName)
				}
			}
			fmt.Printf("├─ 推送路径：%s\n", targetPath)
			timeSpan := group.lastCheckTime.Sub(group.firstCheckTime).Seconds()
			fmt.Printf("└─ 时间跨度：%d秒\n", int(timeSpan))
		}
	}
	// 删除队列
	waitingQueueMu.Lock()
	delete(waitingQueue, targetPath)
	waitingQueueMu.Unlock()
}
