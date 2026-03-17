# ========== 阶段1：构建阶段（仅用于安装依赖，不参与运行） ==========
FROM node:18-alpine AS builder

# 安装 CA 证书 + 清理 apk 缓存（合并命令减少层）
RUN apk add --no-cache ca-certificates && \
    apk cache clean

# 设置工作目录
WORKDIR /app

# 复制依赖配置文件（先复制，利用 Docker 层缓存）
COPY package.json ./

# 安装生产依赖 + 清理 npm 缓存（关键：减少依赖体积）
RUN npm install --omit=dev --registry=https://registry.npmmirror.com && \
    npm cache clean --force

# ========== 阶段2：运行阶段（仅保留必要文件，镜像极小） ==========
FROM node:18-alpine AS runner

# 继承构建阶段的 CA 证书（避免重复安装）
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# 设置工作目录
WORKDIR /app

# 从构建阶段复制必要文件（仅复制 node_modules 和脚本，无其他冗余）
COPY --from=builder /app/node_modules ./node_modules
COPY strm-push.js ./

# 设置生产环境变量
ENV NODE_ENV=production

# 启动脚本（直接用 node 启动，减少 npm 包装层）
CMD ["node", "strm-push.js"]