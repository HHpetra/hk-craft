# HK-Craft 发布流程

将新版本打成 Windows 安装包，并发布到 GitHub Releases。远程仓库：`https://github.com/HHpetra/hk-craft.git`。

版本号使用 SemVer **`x.y.z`**，Git 标签为 **`vx.y.z`**（例如 `0.2.0` / `v0.2.0`）。不要使用 `v0.2` 这类缺 patch 的写法：设置页更新检查只解析三段版本号。

## 1. 同步版本号与文档

把当前版本号（如 `0.1.0`）改为目标版本（如 `0.2.0`）：

| 文件 | 作用 |
| :--- | :--- |
| `package.json` | 设置页显示的 `APP_VERSION`（Vite 构建时注入） |
| `src-tauri/tauri.conf.json` | 安装包文件名中的版本 |
| `src-tauri/Cargo.toml` | Rust crate 版本 |
| `src-tauri/Cargo.lock` | 其中 `name = "hk-craft"` 对应的 `version` |

文档：

- `CHANGELOG.md`：在顶部新增 `## [x.y.z] - YYYY-MM-DD`，按 Added / Changed / Fixed 写本版本变更。
- `README.md`：更新安装包文件名，例如 `HK-Craft_0.2.0_x64-setup.exe` 与 `HK-Craft_0.2.0_x64_en-US.msi`。

不要改旧版本的 Git 标签或已发布的 GitHub Release。

## 2. 先提交，再打包

设置页的 git hash 在打包时由 `git rev-parse --short HEAD` 写入前端。必须先提交版本与文档更改，再构建，否则安装包里的 hash 会对不上发布提交。

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md README.md
git commit -m "chore: 发布 vx.y.z"
```

然后打包：

```bash
pnpm tauri build
```

`pnpm build` 同样会调用 `tauri build`。预期产物：

- `src-tauri/target/release/bundle/nsis/HK-Craft_x.y.z_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/HK-Craft_x.y.z_x64_en-US.msi`

抽查 `dist/assets/index-*.js` 是否包含新版本号和当前短 hash。

## 3. 打标签并推送到 GitHub

```bash
git tag -a vx.y.z -m "HK-Craft vx.y.z"
git push origin master
git push origin vx.y.z
```

## 4. 创建 GitHub Release

本机需能访问 GitHub（Git Credential Manager 或已登录的 `gh`）。用 Changelog 中本版本段落作为说明，上传两个安装包：

```bash
gh release create vx.y.z --repo HHpetra/hk-craft --title "HK-Craft vx.y.z" --notes-file <changelog-excerpt> ^
  src-tauri/target/release/bundle/nsis/HK-Craft_x.y.z_x64-setup.exe ^
  src-tauri/target/release/bundle/msi/HK-Craft_x.y.z_x64_en-US.msi
```

若 `gh` 未登录，可用 Git Credential Manager 取出的 token 设置 `GH_TOKEN` 后再执行同一条命令。不要在日志或聊天里打印 token。

发布页示例：`https://github.com/HHpetra/hk-craft/releases/tag/vx.y.z`

## 5. 发布后核对

- 仓库 `master` 与标签 `vx.y.z` 都已在远程。
- Release 附件包含 NSIS 与 MSI。
- 安装后设置页底部显示新版本号与发布提交的短 hash；打开设置应提示「已是最新」。
