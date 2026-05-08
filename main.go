package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------- 原始配置结构 ----------
type Config struct {
	ProjectAPI    string
	APIKey        string
	TargetWebhook string
	PollInterval  int      // 保留读取，但不再用于轮询
	StrmTasks     []string
	FilterStatus  string   // 保留读取，不再进行状态过滤
	PersistFile   string
	ListenAddr    string   // 新增：webhook 监听地址
}

// ---------- 原始数据结构 ----------
type Task struct {
	ID                 json.Number `json:"id"`
	ResourceName       string      `json:"resourceName"`
	RealFolderName     string      `json:"realFolderName"`
	Status             string      `json:"status"`
	LastCheckTime      string      `json:"lastCheckTime"`
	LastFileUpdateTime string      `json:"lastFileUpdateTime"`
}

type APIResponse struct {
	Success bool   `json:"success"`
	Data    []Task `json:"data"`
}

type PushData struct {
	StrmTask string `json:"strmtask"`
	Event    string `json:"event"`
	SavePath string `json:"savepath"`
}

type TaskGroup struct {
	tasks          []Task
	firstCheckTime time.Time
	lastCheckTime  time.Time
}

type QueueItem struct {
	tasks []Task
	timer *time.Timer
	mu    sync.Mutex
}

// ---------- 全局变量 ----------
var (
	config Config

	sentTaskRecords   = make(map[string]string)
	sentTaskRecordsMu sync.RWMutex

	waitingQueue   = make(map[string]*QueueItem)
	waitingQueueMu sync.Mutex

	lastNoTaskLogAt time.Time

	// 新增：防抖与调度相关
	scheduleMu      sync.Mutex
	lastReceiveTime time.Time
	debounceTimer   *time.Timer
	pending         bool
	running         bool
	exiting         bool
	runCond         = sync.NewCond(&scheduleMu)

	httpServer *http.Server
	debounce   = 10 * time.Second
)

const (
	timeWindowMovieSeconds   = 30
	timeWindowDefaultSeconds = 120
	noTaskLogInterval        = 60 * time.Second
	defaultListenAddr        = ":1234"
)

// ---------- 主流程 ----------
func main() {
	loadConfig()
	checkRequiredEnv()
	initSentTaskRecords()

	fmt.Printf("[%s] 🚀 脚本启动成功 (Webhook 模式)\n", getShanghaiTime())
	fmt.Printf("├─ Webhook 监听地址：%s\n", config.ListenAddr)
	fmt.Printf("├─ 防抖时间：%s\n", debounce)
	fmt.Printf("├─ 电影路径时间窗口：%d秒\n", timeWindowMovieSeconds)
	fmt.Printf("└─ 其他路径时间窗口：%d秒\n", timeWindowDefaultSeconds)

	// 启动 HTTP 服务
	mux := http.NewServeMux()
	mux.HandleFunc("/", webhookHandler)
	httpServer = &http.Server{
		Addr:    config.ListenAddr,
		Handler: mux,
	}

	go func() {
		fmt.Printf("[%s] 🌐 等待 webhook 触发...\n", getShanghaiTime())
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("[%s] ❌ HTTP 服务异常: %v\n", getShanghaiTime(), err)
			os.Exit(1)
		}
	}()

	// 优雅退出
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	gracefulShutdown()
}

// ---------- 配置加载（原样保留） ----------
func loadConfig() {
	projectAPI := strings.TrimSuffix(os.Getenv("PROJECT_API"), "/") + "/api/tasks"
	config = Config{
		ProjectAPI:    projectAPI,
		APIKey:        os.Getenv("API_KEY"),
		TargetWebhook: os.Getenv("TARGET_WEBHOOK"),
		PollInterval:  parseInt(os.Getenv("POLL_INTERVAL")),
		FilterStatus:  os.Getenv("FILTER_STATUS"),
		PersistFile:   filepath.Join(getExeDir(), "data", "sent-tasks.json"),
		ListenAddr:    getEnvOrDefault("WEBHOOK_LISTEN_ADDR", defaultListenAddr),
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

func getEnvOrDefault(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// checkRequiredEnv 移除 POLL_INTERVAL 和 FILTER_STATUS 的强制要求
func checkRequiredEnv() {
	required := map[string]string{
		"PROJECT_API":    config.ProjectAPI,
		"API_KEY":        config.APIKey,
		"TARGET_WEBHOOK": config.TargetWebhook,
		"STRM_TASKS":     strings.Join(config.StrmTasks, ","),
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
	return time.Now().UTC().Add(8 * time.Hour).Format("2006-01-02 15:04:05")
}

// ---------- 以下所有函数均从原始代码完整保留，不做任何修改 ----------

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

// runPolling 完全原样保留，仅被 webhook 防抖后调用
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

	if _, exists := waitingQueue[targetPath]; !exists {
		if expired {
			fmt.Printf("[%s] ⚡ 检测到过期任务，立即推送\n", getShanghaiTime())
			go executePush(targetPath, []Task{task})
			return true
		}

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

	for _, t := range queue.tasks {
		if t.ID.String() == task.ID.String() {
			return false
		}
	}

	if expired {
		fmt.Printf("[%s] ⚡ 检测到过期任务，立即推送队列\n", getShanghaiTime())
		queue.timer.Stop()
		queue.tasks = append(queue.tasks, task)
		go executePush(targetPath, queue.tasks)
		delete(waitingQueue, targetPath)
		return true
	}

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
	sortTasksByTime(allTasks)

	newIndex := -1
	for i, t := range allTasks {
		if t.ID.String() == newTask.ID.String() {
			newIndex = i
			break
		}
	}

	newCheckTime, _ := time.Parse(time.RFC3339, newTask.LastCheckTime)

	if newIndex > 0 {
		prevTask := allTasks[newIndex-1]
		prevCheckTime, _ := time.Parse(time.RFC3339, prevTask.LastCheckTime)
		if newCheckTime.Sub(prevCheckTime) >= time.Duration(timeWindow)*time.Second {
			return false
		}
	}

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

		for _, task := range group.tasks {
			sentTaskRecordsMu.Lock()
			sentTaskRecords[task.ID.String()] = task.LastFileUpdateTime
			sentTaskRecordsMu.Unlock()
		}
		saveSentTaskRecords()

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
	waitingQueueMu.Lock()
	delete(waitingQueue, targetPath)
	waitingQueueMu.Unlock()
}

// ---------- 新增：webhook 处理与防抖调度 ----------

func webhookHandler(w http.ResponseWriter, r *http.Request) {
	io.Copy(io.Discard, r.Body)
	r.Body.Close()
	scheduleRun()
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func scheduleRun() {
	scheduleMu.Lock()
	defer scheduleMu.Unlock()

	if exiting {
		return
	}

	lastReceiveTime = time.Now()

	if running {
		pending = true
		return
	}

	if debounceTimer != nil {
		debounceTimer.Reset(debounce)
	} else {
		debounceTimer = time.AfterFunc(debounce, executeAfterDebounce)
	}
}

func executeAfterDebounce() {
	scheduleMu.Lock()
	defer scheduleMu.Unlock()

	if exiting || running {
		if running {
			pending = true
		}
		return
	}

	running = true
	go func() {
		defer func() {
			scheduleMu.Lock()
			running = false
			runCond.Broadcast()

			if !exiting && pending {
				pending = false
				delay := time.Until(lastReceiveTime.Add(debounce))
				if delay < 0 {
					delay = 0
				}
				debounceTimer = time.AfterFunc(delay, executeAfterDebounce)
			} else {
				debounceTimer = nil
			}
			scheduleMu.Unlock()
		}()
		runPolling()
	}()
}

func gracefulShutdown() {
	fmt.Printf("[%s] ⏳ 正在关闭...\n", getShanghaiTime())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpServer.Shutdown(ctx)

	scheduleMu.Lock()
	exiting = true
	if debounceTimer != nil {
		debounceTimer.Stop()
	}
	for running {
		runCond.Wait()
	}
	scheduleMu.Unlock()

	saveSentTaskRecords()
	fmt.Printf("[%s] 👋 已退出\n", getShanghaiTime())
	os.Exit(0)
}
