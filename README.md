# 勘察企业离线总库

这个项目现在支持两条路径：

1. 网页实时抓取后查询
2. 更推荐的离线总库模式

## 更推荐的做法

如果你不想每次查询都等待抓取，建议直接走离线总库：

1. 一次性预抓取全部勘察资质下的企业
2. 结果缓存到本地
3. 导出 Excel
4. 以后只查本地数据

## 安装

```bash
npm install
```

## 命令

同步资质目录：

```bash
npm run scrape
```

离线预抓取全部勘察企业：

```bash
npm run prefetch:offline
```

说明：

- 支持断点续跑
- 中断后再次执行，会从未完成资质继续
- 进度文件在 `data/offline-progress.json`
- 离线缓存文件在 `data/offline-cache.json`

导出本地 Excel：

```bash
npm run export:offline:xlsx
```

导出文件路径：

```text
E:\桌面\投标助手\output\spreadsheet\勘察企业离线总库.xlsx
```

启动网页：

```bash
npm start
```

浏览器打开：

```text
http://127.0.0.1:3210
```

## 为什么离线模式更适合你

- 不用每次点查询都重新抓
- 抓过一次后，后续查询基本都是本地速度
- 可以直接交付 Excel 文件
- 可以把抓取任务安排在空闲时间慢慢跑完
