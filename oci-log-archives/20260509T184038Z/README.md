# OCI log archive 20260509T184038Z

Source host: `ubuntu@150.136.81.6`

Source path: `/home/ubuntu/morpho-liquidator-v2/logs`

Archive created at: `2026-05-09T18:40:38Z`

The archive excludes `.env` files. It contains the bot runtime logs that were
present before resetting the OCI bot runtime.

Verify:

```sh
cd oci-log-archives/20260509T184038Z
shasum -a 256 -c morpho-oci-logs-20260509T184038Z.tar.zst.sha256
```

List contents:

```sh
tar --use-compress-program=unzstd -tf morpho-oci-logs-20260509T184038Z.tar.zst
```
