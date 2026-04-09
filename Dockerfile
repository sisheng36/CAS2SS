# 阶段1：编译
FROM golang:1.21-alpine AS builder

WORKDIR /build

# 复制依赖文件
COPY go.mod ./

# 下载依赖
RUN go mod download

# 复制源代码
COPY main.go ./

# 静态编译（最小化二进制文件）
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o strm-push .

# 阶段2：运行
FROM alpine:latest

# 安装时区数据和证书
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app

# 从编译阶段复制二进制文件
COPY --from=builder /build/strm-push .

# 创建数据目录
RUN mkdir -p /app/data

# 设置时区
ENV TZ=Asia/Shanghai

# 运行
CMD ["./strm-push"]
