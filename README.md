# GTA VI trophy rarity forecast

Forecasts five quantiles of every GTA VI PS5 trophy's Exophase earn rate at a case's target time for the [make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

[![make.fun competition badge](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![make.fun rank badge](https://make.fun/badge/gta6-trophy-rarity-forecast-01/0xcqing/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![make.fun reward badge](https://make.fun/badge/gta6-trophy-rarity-forecast-01/0xcqing/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

## Run

Node 22, standard library only, no network. The program reads every `*.in` file in the input directory in name order and writes `<id>.out` to the output directory.

POSIX shell:

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force out | Out-Null
$env:MAKEFUN_INPUT_DIR = "input"
$env:MAKEFUN_OUTPUT_DIR = "out"
node main.ts
```

The grader leaves `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` unset, so the defaults `/input` and `/output` are used.
