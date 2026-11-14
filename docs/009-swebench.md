# 009 SWE-bench 评测

本文说明怎样用 SWE-bench Verified 的一个子集衡量 Warren 解决真实代码问题的能力，以及一次评测的结果。前置阅读：[003 运行时](003-runtime.md)、[005 安全边界](005-security.md)、[008 上下文与指标](008-context-and-metrics.md)。

## 评什么

SWE-bench Verified 有 500 个经人工确认的 GitHub issue，每个对应一个 Python 仓库的某个提交。评测时把模型产出的补丁打到仓库上，运行隐藏的测试：

- `FAIL_TO_PASS`：修复前失败、修复后必须通过的测试；
- `PASS_TO_PASS`：原本通过、修复后仍要通过的测试。

两类全部通过才算解决（resolved）。

这里测的是 **Warren 整体**，不只是模型：
- 每个实例都是一个普通任务，走同样的守护进程、Seatbelt 沙箱、Agent 循环和工具，和日常使用一样；
- 没有为评测专门写的工具或提示链。

## 怎么跑

代码在 `evals/swebench/`。

1. **抽样**（`sample.py`）：按 `instance_id` 排序后，用固定种子均匀抽取，可以复现。本次抽了 28 个，种子 `20261114`：前 3 个是试跑，后 25 个是正式评测。
2. **生成补丁**（`run.ts`）：
   - 在进程内启动一个独立的守护进程。它有自己的 home，密钥从用户的 `~/.warren/credentials.env` 读进环境变量，不落盘。
   - 每个实例只拉取基准提交（`--depth 1`），作为任务的源仓库。
   - 任务说明就是 issue 原文，加上几条约束：先在 `$TMPDIR` 里复现，虚拟环境建在 `$TMPDIR`，不提问，不提交、不推送，完成后调用 `complete_task`。
   - 没有人在场。所以：
     - 提问一律回复"自己决定"，审批一律拒绝；
     - 任务停下来时最多催两次；
     - 单个任务超过 40 分钟就取消，模型调用上限 80 次。
   - 补丁取工作区相对基准提交的变化，在任务的沙箱里执行 `git diff`。排除测试补丁会覆盖的文件，也排除 `egg-info` 和 `__pycache__`。
3. **打分**（`score.ts`）：
   - 用官方 harness（`swebench` 5.0.2，数据集 `SWE-bench/SWE-bench_Verified`）在每个实例的官方 Docker 镜像里运行隐藏测试。
   - 镜像只有 x86_64 版本。在 Apple Silicon 上要先用 `--platform linux/amd64` 拉取，再通过 Rosetta 模拟运行。
   - 每个镜像 2–5 GB，所以按批处理：每批 4 个，同一仓库排在一起以共用镜像层，评测当前批时并行下载下一批，评完就删除。
   - 报告写完后，删除任务工作区和仓库克隆。保留补丁、结果、报告、harness 日志和 Warren 的事件日志。

```sh
uv run --python 3.11 --with datasets python evals/swebench/sample.py 28 20261114 evals/swebench/instances.json
bun evals/swebench/run.ts evals/swebench/instances.json 3 25 evals/swebench/runs/main
bun evals/swebench/score.ts evals/swebench/runs/main 4     # 需要 Docker（colima），--keep 跳过清理
```

需要 Docker。本次用的是 colima（vz + Rosetta，8 核、24 GB 内存）。评测结束后可以 `colima delete` 释放磁盘。

## 结果

`gpt-6.1-terra`（main 角色），2026-11-14：

| | 解决 | 比例 |
|---|---|---|
| 试跑 | 3 / 3 | 100% |
| 正式 | 20 / 25 | 80% |
| **合计** | **23 / 28** | **82%** |

按官方给的难度分：

| 难度 | 解决 |
|---|---|
| 15 分钟以内 | 10 / 11 |
| 15 分钟到 1 小时 | 12 / 16 |
| 1–4 小时 | 1 / 1 |

成本与过程：

- **费用：** 28 个实例共 $4.84，中位数每个 $0.16。
- **用时：** 中位数 2.1 分钟，最长 7.1 分钟。
- **模型调用：** 中位数 13 次，最多 24 次。
- **缓存与压缩：** 输入 token 的缓存命中率 90%；没有触发上下文压缩。
- **稳定性：** 28 个任务都以 `complete_task` 正常结束：
  - 没有超时；
  - 没有 harness 错误，所有补丁都能干净地打上。

样本只有 28 个，比例的误差大约是 ±15 个百分点。它说明的是 Warren 的整套流程能在真实仓库上稳定地端到端工作，不适合拿来和排行榜上的数字精确比较。

## 没解决的 5 个

补丁都打上了，问题出在修法：

| 实例 | 现象 |
|---|---|
| `sympy-20428` | 新增的 `test_issue_20427` 没通过：修复的位置和隐藏测试检查的不是同一层 |
| `django-16950` | 目标测试通过，但破坏了一个原本通过的测试（`PASS_TO_PASS` 回归） |
| `sphinx-7462` | 空元组 `()` 的处理和上游修法不同，隐藏测试检查 `unparse` 的输出 |
| `sphinx-8265` | 同类问题：元组默认值的渲染方式和测试期望的不同（33 行，是改动最大的一个） |
| `scikit-learn-26194` | 阈值的修法和测试期望的不同（`roc_curve` 的 `thresholds` 上限） |

可以改进的方向：

- 让任务在提交前跑一遍仓库里相关模块的已有测试，能挡住 `django-16950` 这类回归；
- 对需要猜"上游会怎么修"的问题，可以用 `hard` 角色复核。

## 评测中发现并修正的问题

- **uv 下载的 Python 写不进去。** uv 默认把 Python 装到 `~/.local/share`，这个目录在沙箱外，写入被拒。现在工具环境把 `XDG_DATA_HOME` 指到任务的 scratch 目录（`packages/tools/src/common.ts`）。
- **仓库克隆不稳定。** 完整克隆大仓库（matplotlib）时连接常被中断。改成只拉取基准提交并重试；单个实例失败时记为 "setup failed"，不影响其他实例。
- **镜像架构不对。** harness 会按宿主架构拉 arm64 镜像，但官方镜像只有 x86_64，所以要先指定平台拉取。
- **镜像下载慢。** 国内访问 Docker Hub 时单个连接只有约 1 MB/s。解决办法是提高 Docker 的并发下载数，并在评测当前批时并行下载下一批。
