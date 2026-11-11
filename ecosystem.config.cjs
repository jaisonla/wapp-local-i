module.exports = {
  apps: [{
    name: 'whatsapp',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '400M',
    exp_backoff_restart_delay: 2000,
    kill_timeout: 5000,
    time: true,
    out_file: 'logs/saida.log',
    error_file: 'logs/erros.log',
    merge_logs: true,
    env: { NODE_ENV: 'production' }
  }]
};
