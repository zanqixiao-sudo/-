# Cloudflare Pages 部署说明

## 推荐方式

当前项目建议使用“静态前端 + 离线数据文件”方式部署到 Cloudflare Pages：

- 前端页面：`public/`
- 离线库：`public/data/offline-cache.json`
- 总表下载：`public/downloads/勘察企业离线总库.xlsx`

抓取继续在本地维护机执行，不放到 Cloudflare 上跑。

## 本地准备

先同步静态部署所需文件：

```bash
npm run sync:static
```

执行后会生成或更新：

- `public/data/offline-cache.json`
- `public/downloads/勘察企业离线总库.xlsx`

## Cloudflare Pages 配置

在 Cloudflare Pages 中连接仓库后，使用以下设置：

- Framework preset: `None`
- Build command: `npm run build:pages`
- Build output directory: `public`

## 发布流程

1. 本地抓取更新离线库
2. 本地生成最新 Excel
3. 执行 `npm run sync:static`
4. 提交代码并推送到仓库
5. Cloudflare Pages 自动部署

## 当前页面能力

部署到 Cloudflare 后仍可使用：

- 资质列表展示
- 多资质交集查询
- 企业关键词筛选
- 离线总表下载
- 当前筛选结果前端导出

## 说明

- Cloudflare 站点不负责抓取
- Cloudflare 站点默认显示最近更新时间
- 页面查询与下载直接基于离线库文件
- 仓库中应提交 `public/data/offline-cache.json` 与 `public/downloads/勘察企业离线总库.xlsx`
