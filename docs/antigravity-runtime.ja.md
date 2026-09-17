# Antigravity runtime

`agy` の Workflow は `--dangerously-skip-permissions --prompt-interactive` で対話型 runtime を起動し、設定済みのモデルと effort を指定する。起動時の prompt は送信済みとなり、以後の対話は herdr pane で監督する。

初めて開く worktree では workspace trust の確認が pane に表示される。無人実行前に対象 worktree を信頼済みにする必要がある。

## Permission policy

`--dangerously-skip-permissions` はファイル編集と terminal command を含む全ツールの承認要求を省く。Grok の `--always-approve`、OpenCode の `--auto` と同様に、Workflow の無人起動を進めるための既定値である。`permissions.allow` に command を列挙する必要はない。

`--mode accept-edits` はファイル編集だけを自動承認し、terminal command は権限設定または対話で承認する別のモードである。LoopHub の既定起動には使用しない。全ツールの自動承認は実行できる操作を広げるため、信頼できる repository と作業環境で使用する。[Antigravity execution modes](https://antigravity.google/docs/cli/modes/) を参照。

## Tracking

LoopHub は runtime、session、executionTarget、pane、Workflow event と head SHA を既存の経路で記録する。commit と review は agent が通常の CLI 操作を行ったときに記録される。headless の JSON 出力には `conversation_id` と token `usage` が含まれるが、Workflow が使う対話型 TUI の取得経路は未実装である。conversation id、token usage、cost、subagent 情報を推測して記録しない。
