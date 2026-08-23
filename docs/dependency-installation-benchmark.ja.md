# 依存関係インストールの測定

## 目的

root と `web/` の依存関係インストールを npm から Bun へ移行した際の、clean checkout
相当のセットアップ時間と依存関係フットプリントを比較する。

## 測定条件

- 測定日: 2026-08-23
- 測定環境: macOS、Apple Silicon、同一マシン
- Bun: `1.3.14`
- npm: `11.19.0`
- Node.js: `v26.7.0`
- 各 trial は `git archive HEAD` から作った別の一時 checkout で実行した。
- 各 trial は `git archive HEAD` から作った別の一時 checkout で、`node_modules` を空にして実行した。
- 主測定では同一マシンの通常の npm / Bun package cache を使った。これは新しい checkout で通常に行う
  cold install（依存関係 cache は利用できるが、`node_modules` は存在しない）の比較である。
- 補足測定では各 trial に専用の `HOME` と npm / Bun cache を割り当て、依存関係の cache も共有しなかった。
- npm は移行前の `package-lock.json` と root の `postinstall` を使った。
- Bun は移行後の `bun.lock`、`web/bun.lock`、root の `postinstall` を使った。
- npm と Bun の manifest の `dependencies` / `devDependencies` 宣言は同一である。
- `node_modules` のサイズは root と `web/` の `du -sk` の合計を bytes に換算した。

## 実行コマンド

各 trial の checkout 内で、主測定では次のコマンドを実行した。

```sh
# npm baseline
/usr/bin/time -p npm install

# Bun
/usr/bin/time -p bun install --frozen-lockfile
```

補足測定では、各コマンドにそれぞれ専用の cache を指定した。

```sh
HOME="$TRIAL_DIR/home" /usr/bin/time -p \
  npm install --cache "$TRIAL_DIR/npm-cache"

HOME="$TRIAL_DIR/home" /usr/bin/time -p \
  bun install --frozen-lockfile \
  --cache-dir="$TRIAL_DIR/bun-cache" --no-cache
```

各 trial の後に、次の値を取得した。

```sh
wc -c package-lock.json web/package-lock.json
# または
wc -c bun.lock web/bun.lock
find . -path '*/node_modules/*' -type f | wc -l
du -sk node_modules web/node_modules
```

## 主測定の結果

| manager | trial | install time | root lockfile | web lockfile | `node_modules` files | `node_modules` bytes |
|---|---:|---:|---:|---:|---:|---:|
| npm | 1 | 6.40 s | 65,416 | 228,249 | 29,323 | 454,729,728 |
| npm | 2 | 6.22 s | 65,416 | 228,249 | 29,323 | 455,368,704 |
| npm | 3 | 5.83 s | 65,416 | 228,249 | 29,323 | 454,729,728 |
| Bun | 1 | 1.22 s | 29,734 | 113,404 | 29,519 | 456,613,888 |
| Bun | 2 | 0.57 s | 29,734 | 113,404 | 29,519 | 456,613,888 |
| Bun | 3 | 0.63 s | 29,734 | 113,404 | 29,519 | 456,613,888 |

中央値は npm が 6.22 秒、Bun が 0.63 秒だった。通常の clean checkout setup では、Bun への移行による
セットアップ時間の回帰は確認されなかった。Bun の `node_modules` は中央値で npm より 196 files、
1,884,160 bytes（約 0.4%）大きいが、lockfile は root と `web/` の合計で 293,665 bytes から
143,138 bytes へ縮小した。

## cache なし補足測定

依存関係 cache を共有しない測定では、npm の install time は 24.76 / 17.66 / 16.79 秒、Bun は
19.21 / 27.09 / 19.14 秒だった。中央値は npm 17.66 秒、Bun 19.21 秒であり、この条件では Bun が
1.55 秒遅かった。registry からの取得時間の影響が大きく trial 間の変動もあるため、通常の clean
checkout setup の判定とは分けて記録する。いずれの補足 trial も exit 0 で、lockfile と
`node_modules` の計測値は主測定と同じだった。
