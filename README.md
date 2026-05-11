# cas2ss — CAS 任务更新自动推送到 SmartStrm
生成时间：2026-05-08 12:51:33

本项目是一个轻量级的中间件，负责监听 Webhook 触发，自动从 CAS 拉取最新的文件更新任务，并按路径聚合后推送到 SmartStrm (SS) 的 Webhook，实现自动化拨剧/更新 strm 文件。

## ✨ 工作流程
1. 本服务在 1234 端口（可自定义）启动 HTTP 服务器，等待上游系统发送的任意 Webhook 通知。
2. 收到请求后，启动 10 秒防抖：若短时间内收到多次请求，以最后一次接收时间为准，延迟 10 秒后统一触发一次任务查询。
3. 向 CAS 的 `/api/tasks` 接口查询当前所有符合条件的任务（文件夹不为空，且文件有更新）。
4. 根据任务的 `realFolderName` 提取推送路径，并按时间窗口（电影类 30 秒、其他 120 秒）进行聚合，合并或立即推送任务到 SS。
5. 推送成功后记录任务 ID 及最后文件更新时间，避免重复推送，并持久化到磁盘。

## 🚀 快速开始
### 1. 准备环境
- 一台可以访问 CAS 和 SS 的服务器或 Docker 环境
- 已获取 CAS 后台生成的 `API_KEY`
- 已知 SS 的目标 Webhook URL（格式通常为 `http://<ss-host>:<port>/webhook/<token>`）

### 2. 使用 Docker Compose（推荐）
将以下内容保存为 `docker-compose.yml`：

```yaml
services:
  cas2ss:
    image: sisheng36/cas2ss:latest
    container_name: cas2ss
    network_mode: bridge
    restart: always
    ports:
      - "1234:1234"
    environment:
      - PROJECT_API=http://your-cas-address:3000        # 替换为你的 CAS 地址
      - API_KEY=your-api-key-here                        # 替换为你的 API Key
      - TARGET_WEBHOOK=http://your-ss-webhook-url       # 替换为 SS Webhook
      - STRM_TASKS=电影1,电影2,动漫1                     # 替换为你在 SS 中创建的任务名
      - TZ=Asia/Shanghai
      # 可选配置
      # - WEBHOOK_LISTEN_ADDR=:1234                      # 自定义监听端口
    volumes:
      - ./cas2ss:/app/data                               # 持久化已推送记录
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

然后在该目录下执行启动命令：

```bash
docker-compose up -d
```

### 3. 手动配置环境变量（非 Docker）
可直接运行编译好的二进制文件，需配置以下环境变量：

| 变量名                | 必填 | 说明                                                                 |
| :-------------------- | :--- | :------------------------------------------------------------------- |
| PROJECT_API           | ✅    | CAS 服务地址（例：`http://192.168.1.100:3000`），程序自动追加 `/api/tasks` |
| API_KEY               | ✅    | CAS 后台生成的 API 密钥                                              |
| TARGET_WEBHOOK        | ✅    | SmartStrm 目标 Webhook 完整 URL                                   |
| STRM_TASKS            | ✅    | SS 中配置的任务名称，多个用英文逗号分隔                              |
| WEBHOOK_LISTEN_ADDR   | ❌    | 本服务监听地址，默认值 `:1234`                                       |
| TZ                    | ❌    | 时区，推荐设置为 `Asia/Shanghai`                                     |

## 🔄 更新触发方式
服务启动后，对外暴露 HTTP 端点（默认 `http://<本机IP>:1234`）。
任何发送到此端口的 HTTP 请求（GET/POST/任意路径），都会触发一次任务同步。

常规使用方式：由 CAS 或其他调度系统在任务执行完成后，向该地址发送回调请求。

## 📁 数据持久化
已推送的任务记录保存在 `./data/sent-tasks.json` 中（Docker 部署映射至 `./cas2ss` 文件夹）。
- 单条记录包含任务 ID 与最后一次文件更新时间 `lastFileUpdateTime`
- 程序重启后，已推送且文件无更新的任务不会重复推送
- 如需重置推送记录，可直接删除或清空该文件

## 🧠 聚合窗口规则
- 电影类路径（含「电影」或「movie」关键词）：聚合时间窗口 30 秒
- 其他路径（剧集、动漫等）：聚合时间窗口 120 秒
- 同一路径下、同一窗口内的多个任务，会合并为一次推送，降低 SS 服务处理压力
- 超出窗口的过期任务会立即推送，不进入等待队列

## 📊 运行日志示例
```text
[2026-05-08 10:47:18] 🚀 脚本启动成功
├─ Webhook 监听地址：:1234
├─ 防抖时间：10s
├─ 电影路径时间窗口：30秒
└─ 其他路径时间窗口：120秒
[2026-05-08 10:47:18] 🌐 HTTP 服务已启动，等待 webhook...
[2026-05-08 10:47:36] 📥 新增任务到等待队列：The OutCast
[2026-05-08 10:48:06] ✅ 推送成功（合并推送）
├─ 合并任务数：2个
├─ 任务ID列表：12,15
├─ 资源名称：
│  ├─ The OutCast/Season 05
│  └─ The OutCast/Season 06
├─ 推送路径：/更新中/The OutCast
└─ 时间跨度：15秒
```

## 🔧 常见问题排查
### Q: 日志持续提示「暂无符合条件的新任务」
A: 常见原因与解决方案：
1. CAS 中暂无 `realFolderName` 不为空的有效任务
2. 任务的 `lastFileUpdateTime` 无更新，已被程序标记为已推送
3. 可删除 `data/sent-tasks.json` 重置记录后重试，或检查 CAS 接口返回数据

### Q: 推送失败如何处理
A: 推送失败不会更新已推送记录，下次触发时会自动重试。请优先检查：
1. `TARGET_WEBHOOK` 地址拼写正确、网络可达
2. SS 服务正常运行，Webhook 接口可正常接收请求
3. 查看 SS 服务端日志，排查接口报错原因

### Q: 如何修改服务监听端口
A: 新增/修改环境变量 `WEBHOOK_LISTEN_ADDR=:端口号` 即可，例如 `WEBHOOK_LISTEN_ADDR=:8080`

### Q: 访问CAS地址提示「URL拼写可能存在错误，请检查」
A: 内网地址访问报错排查方案：
1. 确认CAS服务的IP、端口拼写无误，无多余空格、特殊字符
2. 确认部署cas2ss的服务器/容器与CAS服务处于同一内网，网络互通
3. 确认防火墙/安全组未拦截两端的网络访问，CAS服务端口已对外开放
4. 确认 `PROJECT_API` 仅填写CAS根地址，无需手动追加 `/api/tasks` 路径

## 📃 开源协议
本项目仅用于个人学习与自动化管理，请勿用于非法用途。
