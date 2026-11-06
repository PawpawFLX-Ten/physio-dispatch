import { useState } from "react"
import { api } from "../api.js"

export function CloudBackups({ pending, run, download, onRefresh, onClose }) {
  const [listing, setListing] = useState(null)
  return (
    <section className="instruction-editor">
      <h3>Cloudflare 云端备份</h3>
      <p className="muted">保存前自动保留最近 30 份分钟备份及最近 30 个有改动日期的日备份。仍建议定期下载一份机外备份。</p>
      <button type="button" className="secondary" disabled={pending} onClick={() => run(async () => setListing(await api.cloudBackups()))}>{listing ? "刷新云端备份列表" : "查看云端备份"}</button>
      {listing ? <div className="patient-list">
        {!listing.backups.length ? <p className="muted">尚未生成备份；建立名单后的后续保存会自动备份。</p> : null}
        {listing.backups.map((backup) => <div key={backup.id} className="stack">
          <strong>{new Date(backup.createdAt).toLocaleString("zh-CN", { hour12: false })} · {backup.kind === "day" ? "日备份" : "分钟备份"}</strong>
          <div className="today-template-buttons">
            <button type="button" className="secondary" disabled={pending} onClick={() => run(async () => download(await api.cloudBackup(backup.id)))}>下载</button>
            <button type="button" className="secondary" disabled={pending} onClick={() => {
              if (!window.confirm("恢复会替换整间治疗室的数据，包括所有手机看到的派工。建议先导出当前数据，确定继续？")) return
              run(async () => {
                await api.restoreCloudBackup(backup.id, listing.sequence)
                await onRefresh()
                onClose()
              })
            }}>恢复这份</button>
          </div>
        </div>)}
      </div> : null}
    </section>
  )
}
