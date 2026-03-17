# CAS2SS
本项目在豆包AI指导下完成

因cloud_auto_save作者已不再更新基础项目，为解决自动化问题，此项目使用cloud189_auto_save的api，将转存任务的消息消息通过webhook推送至smartstrm，用以自动生成strm链接。
# 拉取镜像
docker pull ghcr.io/sisheng36/cas2ss:latest
# 运行容器
docker run -d \
  --name cas2ss-container \
  -v /宿主机路径:/app/data \
  -e PROJECT_API="你的API地址" \#cas的api地址，如http://127.0.0.1:3000/api/tasks
  
  -e API_KEY="你的API密钥" \#cas里生成的api密钥
  
  -e TARGET_WEBHOOK="你的Webhook地址" \#ss的webhook地址，如http://127.0.0.1:8024/webhook/**********
  
  -e POLL_INTERVAL="15" \#每15秒监听一次
  
  -e STRM_TASKS="国产剧1,国产剧2,国产剧3" \#任务名之间用英文逗号连接
  
  -e FILTER_STATUS="processing" \#追剧中
  
  -e DELAY="10" \#延迟刮削10秒
  
  --restart=always \
  ghcr.io/sisheng36/cas2ss:latest
