/// <reference types="vite/client" />
// 让 TS 认识 import.meta.env（BASE_URL / DEV / PROD 等）。
// 2026-09-27 补：渲染进程引用静态资源时用 import.meta.env.BASE_URL 拼路径，
// 这样 dev（base '/'）与构建（base './'，file:// 加载）两种基路径下都成立 ——
// 写死 '/assets/...' 在 file:// 下会解析到磁盘根目录，表现为图标全碎。
