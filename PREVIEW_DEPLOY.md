# 外部预览模式使用说明

## 本地启动预览模式

如果你想先在本机演示一个带口令的预览站，直接执行：

```powershell
npm run preview:start
```

当前默认预览口令为：

```text
666666
```

如果你更想手动指定环境变量，也可以在 Windows PowerShell 中执行：

```powershell
$env:HOST="0.0.0.0"
$env:PORT="3210"
$env:PREVIEW_MODE="1"
$env:PREVIEW_ACCESS_PASSWORD="666666"
$env:OFFLINE_WORKER_DISABLED="1"
node src/server.js
```

说明：

- `PREVIEW_MODE=1`：开启外部预览模式
- `PREVIEW_ACCESS_PASSWORD`：预览口令
- `OFFLINE_WORKER_DISABLED=1`：关闭抓取守护，预览站只读
- `HOST=0.0.0.0`：允许其他设备访问

## 对外分享前需要准备

确认这些文件已经是你想分享的版本：

- `data/offline-cache.json`
- `output/spreadsheet/勘察企业离线总库.xlsx`

## 预览模式行为

- 未输入预览口令前，不能访问首页、查询接口、下载接口
- 输入正确口令后，可访问：
  - 查询首页
  - 资质筛选
  - 企业查询
  - 离线总表下载
  - 当前筛选表下载
- 预览模式不会自动抓取，只读取当前离线库

## 云上部署建议

如果要部署到短期云服务器：

1. 上传项目代码
2. 上传离线库和 Excel 文件
3. 配置环境变量：
   - `HOST=0.0.0.0`
   - `PORT=你的端口`
   - `PREVIEW_MODE=1`
   - `PREVIEW_ACCESS_PASSWORD=666666`
   - `OFFLINE_WORKER_DISABLED=1`
4. 启动 `node src/server.js`
5. 用 HTTPS 域名或平台生成的公网链接分享

## 数据更新方式

预览站本身不抓取数据。

更新方式是：

1. 在维护机完成补库
2. 替换预览机上的：
   - `data/offline-cache.json`
   - `output/spreadsheet/勘察企业离线总库.xlsx`
3. 重启预览服务
