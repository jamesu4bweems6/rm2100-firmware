# WiFi 仅内网（一键禁止某个 WiFi 上网）

LuCI「网络 → WiFi 仅内网」列出路由器上的所有 WiFi，每个 WiFi 一个按钮：

- **禁止上网**：连这个 WiFi 的手机、电脑只能访问内网——路由器、网线连接的设备、同一网段的其他设备（邻传、局域网共享、投屏、NAS 都正常），但打不开外网。
- **恢复上网**：取消限制。

点按钮立即生效，已经建立的外网连接也会被切断；网线连接的设备和其他 WiFi 不受影响。设置在路由器重启、WiFi 重启后保持，升级固件（保留配置）时也会保留。

命令行等价操作：

```sh
/usr/libexec/wifi-lanonly/ctl set 91 1    # 让 WiFi「91」仅内网
/usr/libexec/wifi-lanonly/ctl set 91 0    # 恢复上网
/usr/libexec/wifi-lanonly/ctl status      # JSON 状态：每个 WiFi 是否仅内网、在线设备数、累计拦截包数
```

## 注意

- **按 WiFi 名称生效**。两个频段用同一个名称时会一起限制；在「网络 → 无线」里给 WiFi 改名后，限制不会跟着走，要对新名称重新点一次（旧名称会继续列在页面上，方便取消）。
- 限制的是「出外网」。设备照样能连上 WiFi、拿到 IP、用路由器的 DNS；手机通常会提示「已连接，但无法访问互联网」，这是预期的。
- 只限制「仅内网」WiFi 上的设备主动访问外网；外网到这些设备本来就进不来（NAT）。

## 原理

WiFi 和网线口都在同一个网桥 `br-lan` 里、同一个网段，路由器在路由层分不出包是从 WiFi 还是网线来的。所以分两步：

1. `/etc/wifi-lanonly.nft`（由 `ctl` 按 `/etc/wifi-lanonly.list` 生成，fw4 以 `ruleset-append` 引入）在**网桥层**（`bridge` 族 prerouting）给从选中 WiFi 网口（如 `phy1-ap0`）进来的包打上 `0x40000000` 标记。需要 `kmod-nft-bridge`，固件已内置。
2. `/etc/nftables.d/40-wifi-lanonly.nft` 在 `inet fw4` 的转发链（优先级 -20，早于 fw4 的放行规则）拒绝带标记、且出口不是 `br-lan` 的包，也就是发往外网的包。

同网段设备之间的通信在网桥里二层转发，不经过 inet 转发链；访问路由器本身走 input 链，所以内网完全不受影响。

可靠性：

- `ctl` 写入规则前先让内核 `nft -c` 校验；校验失败（例如缺少 `kmod-nft-bridge`）时不启用网桥规则，不会拖垮整套防火墙。
- WiFi 重启时网口会被重建：`/etc/hotplug.d/net/60-wifi-lanonly` 等 hostapd 就绪（能读到 SSID）后重新生成规则；读不到 SSID 时 `ctl` 不改动规则，避免重启的几秒内意外解除限制。网口名称（`phyN-apM`）在重启前后不变，开机时 fw4 直接载入上次生成的规则，WiFi 一起来就受限。

## 验证

`python tests/test_wifi_lanonly.py`：用 BusyBox ash / dash 实跑 `ctl`（iwinfo、nft、fw4、uci 用桩函数），覆盖只标记选中 SSID 的 AP 网口（不碰有线口和客户端模式网口）、双频同名、含引号/反斜杠/中文的 SSID、正则元字符、关闭后删除网桥表、内容不变不重载防火墙、WiFi 未就绪不解除限制、校验失败不交给 fw4、JSON 状态、非法输入；CI 另用真实 nft 校验生成的网桥规则与转发规则，并在镜像里核对文件、权限与 `kmod-nft-bridge`。

2026-11-05 已在 RM2100 真机（v2.14.1 上手动部署同一套文件）验证：规则通过内核校验、只标记 WiFi「91」的网口、有线设备和路由器自身外网正常、WiFi 重启后规则自动恢复。真实 WiFi 设备的拦截效果待用手机确认。
