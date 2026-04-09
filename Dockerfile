# 阶段1：编译
FROM golang:1.21-alpine AS builder

WORKDIR /build

COPY go.mod ./
RUN go mod download

COPY main.go ./

# 静态编译
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o strm-push .

# 阶段2：空镜像
FROM scratch

# 复制证书（HTTPS请求需要）
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

WORKDIR /app

COPY --from=builder /build/strm-push .

CMD ["./strm-push"]
