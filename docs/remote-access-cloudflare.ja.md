# Cloudflare Tunnel + Access による LoopHub の公開

この手順は、LoopHub の `lh-web` を `127.0.0.1:8730` に bind したまま、Cloudflare の outbound Tunnel と Access を使って、本人が認証したブラウザだけから HTTPS で利用するためのものです。LoopHub の `/rpc` はシェルコマンド実行やエージェント起動につながる高権限 API なので、Cloudflare Access と LoopHub の exact origin allowlist の両方を設定してください。

## 前提と安全上の注意

- Cloudflare account、管理対象 domain、DNS、利用する IdP、本人の exact email、MFA 方針を人間が用意します。
- Cloudflare の credential と connector token は repository に保存せず、`cloudflared` の credential store または OS の secret storage で管理します。
- `LOOPHUB_HOST` は設定せず、`lh-web --port 8730` を起動します。`127.0.0.1:8730` 以外へ bind する変更はこの構成の前提外です。
- Settings の `Public origin` には、Access の public hostname と一致する `https://loop.example.com` のような origin 全体を入力します。`*`、パス付き URL、suffix match、任意の Origin は許可されません。
- この設定は認証済み Access 利用者へ LoopHub の高権限 `/rpc` を公開します。Access の Allow policy が本人限定でない状態を成功扱いにしません。

## LoopHub の設定

1. `lh-web --port 8730` を起動し、ローカルの Settings を開きます。
2. `Public origin` に Cloudflare 側の public hostname を `https://` 付きで入力して保存します。
3. Settings を再読み込みし、値が再表示されることを確認します。未設定に戻す場合は空欄で保存します。
4. 設定変更後に `lh-web` を再起動し、設定が SQLite から再読み込みされることを確認します。

未設定時は従来どおり loopback origin のみが `/rpc` に許可されます。設定後も登録値と完全一致しない public origin は拒否されます。

## Named Tunnel

Cloudflare dashboard または `cloudflared tunnel` の公式手順で、管理対象 domain に named Tunnel を作成します。connector を LoopHub ホストへインストールし、Tunnel の service URL を次のように設定します。

```yaml
ingress:
  - hostname: loop.example.com
    service: http://127.0.0.1:8730
  - service: http_status:404
```

connector token / credential は dashboard の対象 Tunnel に限定し、ホスト上で `cloudflared tunnel run <tunnel-name>` を起動します。Quick Tunnel や Funnel、host の port forwarding は使用しません。

## Cloudflare Access

1. Access で `https://loop.example.com` の self-hosted application を作成します。
2. 利用する IdP を登録し、本人の exact email だけを対象にした Allow policy を作成します。
3. それ以外の identity を許可する policy を追加せず、deny-by-default になることを確認します。
4. MFA を IdP 側で必須にし、Access session の有効期間を組織のリスク許容度に合わせて設定します。
5. policy の変更後、既存 session を含めて未認証・本人・許可外 identity の結果を確認します。

Cloudflare Access の認証は LoopHub の origin 検査の代替ではありません。Access の hostname と LoopHub Settings の `Public origin` が同じ exact origin であることを確認します。

## end-to-end 検証

同じ検証時刻を記録し、Access audit、Tunnel status、LoopHub log を照合します。

- 未認証の PC / スマートフォン通常ブラウザは Access で拒否される。
- 本人の認証済みスマートフォン通常ブラウザでは SPA が表示され、読み取り操作と安全な設定読み取りなどの `/rpc` 操作が成功する。
- 許可外 identity は Access で拒否される。
- `Origin: https://loop.example.com` は exact match で許可され、別 hostname、別 port、パス付き値、malformed value は `/rpc` が `403` になる。
- ホストでは `127.0.0.1:8730` のみが listen し、ホスト外から `host-ip:8730` へ直接到達できない。
- connector を停止すると public hostname から LoopHub へ到達できず、再起動後に復旧する。
- `ss` / `lsof` 等で bind address を確認し、Access audit の identity・Tunnel status の時刻・LoopHub log の時刻を同じ検証記録へ残す。

## 実機検証記録（2026-08-17）

Cloudflare Tunnel と Access を実環境で設定し、本人限定 Allow policy と独立 MFA（TOTP / 生体認証 / security key、session 8 時間）を有効にして Android の通常ブラウザで確認した。

- Access の本人ログインと MFA 完了後、LoopHub SPA を表示できた。
- Settings の `Public origin` に Access の public hostname と完全一致する HTTPS origin を保存し、再取得できた。
- 設定済み exact origin の `/rpc` は `200`、別 hostname の Origin は `403` だった。
- 未認証の public URL は Cloudflare Access login への `302` だった。
- named Tunnel connector は Cloudflare edge へ接続中で、LoopHub は `127.0.0.1:8730` のみで listen していた。
- Tunnel credential、API Token、実ドメイン、本人メールは repository に保存していない。

## rollback / recovery

緊急時は Access application の policy を deny-only にし、Tunnel connector を停止し、LoopHub Settings の `Public origin` を空欄で保存して `lh-web` を再起動します。credential 漏えいが疑われる場合は Cloudflare dashboard で token を revoke / rotate し、IdP session を無効化します。原因と復旧確認を記録してから、本人限定 policy、MFA、exact origin を再確認して段階的に再開します。
