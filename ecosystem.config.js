require('dotenv').config();  // 如果项目中有 dotenv

// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'my-app',
    script: 'app.js',
    
    // 运行配置
    instances: 1,              // 实例数量，可以设置为 'max' 使用所有CPU核心
    exec_mode: 'fork',        // 执行模式：fork 或 cluster
    autorestart: true,        // 自动重启
    watch: false,             // 文件变化自动重启（生产环境建议false）
    
    // 环境变量 - 优先级：环境变量 > .env文件 > 默认值
    env: {
      NODE_ENV: process.env.NODE_ENV || 'production',
      PORT: process.env.PORT || 3000,
      TOKEN: process.env.TOKEN || '',
      ENCODING_AES_KEY: process.env.ENCODING_AES_KEY || '',
      CORP_ID: process.env.CORP_ID || '',
    },
    
    // 日志配置
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,               // 日志添加时间戳
    
    // 内存限制
    max_memory_restart: '1G', // 内存超过1G时自动重启
    
    // 启动延迟
    listen_timeout: 5000,     // 监听超时时间
    kill_timeout: 5000,       // 杀死进程超时时间
    
    // 其他配置
    merge_logs: true,         // 合并日志
    instance_var: 'INSTANCE_ID',
  }]
};
