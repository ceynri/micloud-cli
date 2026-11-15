# 小米云录音 API 笔记

接口来自 i.mi.com 录音网页端（`https://i.mi.com/record`，前端包 `mcfe--micloud-record`），均已用真实账号验证。登录态与笔记等其他 i.mi.com 服务通用（cookie 里的 `serviceToken`）。

## 通用约定

- 读：`GET`，query 带 `ts=<毫秒>` 防缓存。
- 写：`POST`，`application/x-www-form-urlencoded`，body 带 `serviceToken`（取自 cookie）。
- 响应信封：`{ result, retriable, code, data, description, ts }`，`code === 0` 为成功；失败时 `result: "error"` 并带 `reason`。
- 登录态失效返回 HTTP 401，body 形如 `{"R":401,"S":"Err","D":"<登录地址>"}`。
- `code: 308` 表示账号数据在其他区域，`data.redirectUrl` 给出对应域名。

已知错误码：`50202` 文件或目录不存在；`50006` 云空间已满（恢复时出现）。

## 端点

| 能力 | 方法 | 路径 | 参数 |
|---|---|---|---|
| 录音列表 | GET | `/sfs/ns/recorder/dir/0/list` | `offset`、`limit`（网页端 500）、`_dc` |
| 回收站列表 | GET | `/sfs/ns/recorder/deleted` | `syncToken`（首页为空）、`limit` |
| 删除（移入回收站） | POST | `/sfs/ns/recorder/file/{id}/delete` | `permanent=false` |
| 从回收站恢复 | POST | `/sfs/ns/recorder/deleted/{id}/{ver}/recover` | — |
| 从回收站永久删除 | POST | `/sfs/ns/recorder/deleted/{id}/{ver}/purge` | — |
| 直链（播放 / 下载） | GET | `/sfs/ns/recorder/file/{id}/storage/geturl` | — |
| 分块下载凭证 | GET | `/sfs/ns/recorder/file/{id}/block/storage` | — |
| 下载跳转（JSONP） | GET | `/sfs/ns/recorder/file/{id}/cb/{callback}/storage` | — |
| 云空间用量 | GET | `/status/alldetail` | — |
| 昵称头像 | GET | `/status/lite/profile` | — |

分页：录音列表单页返回不满 `limit` 即为最后一页；回收站响应不再带 `syncToken` 即为最后一页。

## 录音条目

```json
{
  "id": "10000000000000004",
  "ver": "10000000000000004",
  "sha1": "3f786850e387550fdab836ed7e6dc881de23001b",
  "size": 84858048,
  "name": "2026年07月02日 16点04分.mp3_3536_0_1782982976700_1782983001427",
  "type": "file",
  "parent_id": "0",
  "create_time": 1782983009010,
  "modify_time": 1782983009010,
  "extraInfo": "{\"mark\": \"\",\"time\": 0,\"appType\": 0,\"appTypeTime\": 0}"
}
```

`name` = `<手机文件名>.<扩展名>_<时长秒>_<类型码>_<文件时间>_<上传时间>`：

- 时长段只在新格式里有；没有时网页端按码率估算（`1_mp3` 8kbps、`0_mp3` 64kbps、`0_amr` 24kbps、`0_3gpp` 160kbps、`2_mp3` 32kbps，其余 64kbps）。
- 类型码：`0` 录音机、`1` 通话、`2` FM、`3` 应用录音（微信 / 企业微信等）；未知类型码网页端归入录音机。
- 文件时间是手机上文件的修改时间，约等于录音结束时间。
- 通话录音手机文件名形如 `[xx@]联系人(号码)_yyyyMMddHHmmss`；应用录音形如 `微信录音 对方昵称_yyyyMMddHHmmss`；`extraInfo.appType` 1 为微信、2 为企业微信。

`ver` 在删除、恢复时都会变化：回收站的 `recover` / `purge` 必须用回收站条目当前的 `ver`；回收站条目的 `modify_time` 即删除时间。

## 下载

- `storage/geturl` 返回预签名直链（`*.xmssdn.micloud.mi.com/.../download_file?...&ts=<过期毫秒>&sig=...`），**无需 cookie**，支持 `Range`，内容即原始音频，SHA-1 与条目 `sha1` 一致。实测有效期约 4 小时。
- `block/storage` 返回 `{ kss: { blocks: [{ sha1, size, urls }], secure_key } }`：分块内容经 RC4 加密，密钥为 `secure_key` 的十六进制解码，每块独立初始化；账号开启「高级数据保护」时还会带 `encryptInfo`，需要设备侧密钥解密，网页端此时只支持在客户端下载。
- `cb/{callback}/storage` 返回一个 JSONP 跳转地址，调用后拿到 `{ url, meta }`，网页端用表单 POST 触发浏览器下载；功能上与 `geturl` 等价。

## 回收站保留期

按 `/status/alldetail` 的 `level`：`None` 30 天、`FirstLevel` 60 天、`SecondLevel` 90 天、`ThirdLevel` 180 天。

## 删除的影响

网页端删除确认文案：「已登录云服务的所有设备上的录音也将被删除」——云端删除会同步删除手机上的录音文件。
