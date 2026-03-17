# 阶段1：构建依赖
FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --production

# 阶段2：生成最终镜像（更小体积）
FROM node:18-alpine
WORKDIR /app
# 复制构建阶段的依赖和脚本
COPY --from=builder /app/node_modules ./node_modules
COPY strm-push.js ./
# 创建数据目录（持久化任务ID）
RUN mkdir -p /app/data
# 启动脚本
CMD ["npm", "start"]
