import { useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api.js"
import { TARGETS, allowsWork, targetById } from "@shared/catalog.js"
import { CHIEF_SITES, DEFAULT_PAIRINGS } from "@shared/pairings.js"
import { matchesInitials } from "../pinyin.js"
import { PairingChips } from "../PairingChips.jsx"
import { CloudBackups } from "./CloudBackups.jsx"
import "./today.css"

// 今日单的设置弹层：备份导出导入、我是谁、常见搭配编辑器、归档病人、模板管理。
// 弹层自己的草稿状态（新名字、搭配编辑、导入文件框）都收在这儿，不占今日单的脑子。
export function SettingsSheet({ snap, pending, error, run, onClose, onRefresh }) {
  const [newStaffName, setNewStaffName] = useState("")
  // 常见搭配编辑器：draft 为 null 是收起状态；site 是正在编辑的部位页签。
  const [pairingDraft, setPairingDraft] = useState(null)
  const [pairingSite, setPairingSite] = useState(CHIEF_SITES[0])
  const [pairingQuery, setPairingQuery] = useState("")
  const importRef = useRef(null)
  const [notifyPermission, setNotifyPermission] = useState(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
    return window.Notification.permission
  })
  const notificationsAvailable =
    typeof window !== "undefined" && "Notification" in window && Boolean(window.isSecureContext)
  const archivedPatients = (snap.patients || []).filter((patient) => patient.archived)
  const templates = snap.templates || []
  const equipmentTypes = snap.equipmentTypes || []
  const equipmentUnits = snap.equipmentUnits || []
  const equipmentLedger = equipmentTypes.map((type) => {
    const units = equipmentUnits
      .filter((unit) => unit.equipmentTypeId === type.id)
      .sort((left, right) => (left.order || 0) - (right.order || 0))
    const shared = type.category === "shared" || type.requiresUnit === false
    return { type, units, shared }
  })

  function downloadExport(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `clinic-${snap.date || "backup"}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const exportAgeDays = (() => {
    if (!snap.lastExportAt) return null
    const at = Date.parse(snap.lastExportAt)
    if (!Number.isFinite(at)) return null
    return Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000))
  })()
  const clinicUrl = typeof window !== "undefined" ? window.location.origin : ""

  function onImportFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (
      !window.confirm(
        "导入会替换这间治疗室的全部数据（病人、今日单、模板），影响所有手机。确定继续？",
      )
    ) {
      return
    }
    run(async () => {
      const text = await file.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error("这个文件不是有效的 JSON")
      }
      await api.importClinic(data)
      await onRefresh()
      onClose()
    })
  }

  return createPortal(
            <div className="sheet-back" onClick={() => onClose()}>
              <div
                className="sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="sheet-handle" />
                <h2 id="settings-title">设置</h2>
                <p className="muted">关掉标签后仍会记住这台手机绑定的名字。</p>
                <p className="error sheet-error">{error}</p>
                {clinicUrl ? (
                  <>
                    <h3>{snap.hosting === "cloudflare" ? "本站地址" : "本机地址"}</h3>
                    <p className="muted">{clinicUrl}</p>
                    <p className="muted">{snap.hosting === "cloudflare" ? "通过 Cloudflare Access 登录后使用。数据由 Cloudflare 保存，无需治疗室电脑常开。" : "同一 Wi‑Fi 的手机用这个地址打开（以终端打印的局域网 IP 为准）。"}</p>
                  </>
                ) : null}
                <h3>任务提醒</h3>
                {!notificationsAvailable ? (
                  <p className="muted">
                    当前用 HTTP 打开，浏览器不开放本地通知。用 HTTPS 或“添加到主屏”后，可显示任务角标并在后台收到本机提醒；手机省电策略仍可能延迟。
                  </p>
                ) : notifyPermission === "granted" ? (
                  <p className="muted">
                    已开启。新任务会增加桌面角标；页面在后台但未被系统挂起时会弹本机通知。锁屏推送仍取决于手机系统。
                  </p>
                ) : notifyPermission === "denied" ? (
                  <p className="error">浏览器已拒绝通知；可到网站设置里重新允许。</p>
                ) : (
                  <>
                    <p className="muted">开启后，新任务会增加角标；页面在后台时会尽量弹本机提醒。</p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={pending}
                      onClick={() => {
                        run(async () => {
                          const result = await window.Notification.requestPermission()
                          setNotifyPermission(result)
                        })
                      }}
                    >
                      开启任务提醒
                    </button>
                  </>
                )}
                <h3>备份</h3>
                <div className="today-template-buttons">
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const data = await api.exportClinic()
                        downloadExport(data)
                        await onRefresh()
                      })
                    }
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending}
                    onClick={() => importRef.current?.click()}
                  >
                    导入
                  </button>
                  <input
                    ref={importRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={onImportFile}
                  />
                </div>
                <p className="muted">
                  {snap.lastExportAt
                    ? `上次导出：${new Date(snap.lastExportAt).toLocaleString("zh-CN", { hour12: false })}`
                    : "还没有导出过，建议每周拷一份到 U 盘或网盘。"}
                </p>
                {exportAgeDays != null && exportAgeDays >= 7 ? (
                  <p className="error">已经超过 7 天没导出，建议现在拷一份机外备份。</p>
                ) : null}
                <p className="muted">导出会下载完整 JSON；导入会替换治疗室全部数据，请先确认。{snap.hosting === "cloudflare" ? "云版数据及导入上限约 8MB；大文件请联系维护者迁移。" : ""}</p>
                {snap.hosting === "cloudflare" ? <CloudBackups pending={pending} run={run} download={downloadExport} onRefresh={onRefresh} onClose={onClose} /> : null}
                {/* 微信内置浏览器大概率不执行 blob 下载：别让人以为备份成功了。 */}
                {/MicroMessenger/i.test(navigator.userAgent) ? (
                  <p className="error">微信里可能下载不了导出文件：用系统浏览器打开上面的本机地址再导出。</p>
                ) : null}
                <h3>我是谁</h3>
                <div className="patient-list">
                  {snap.staff?.map((person) => (
                    <button
                      key={person.id}
                      type="button"
                      className={snap.me?.id === person.id ? "row-btn patient-row is-me" : "row-btn patient-row"}
                      onClick={() =>
                        run(async () => {
                          await api.claim({ staffId: person.id })
                          await onRefresh()
                          onClose()
                        })
                      }
                    >
                      <span className="patient-name">{person.name}</span>
                    </button>
                  ))}
                </div>
                {/* 单人时新手机会被自动认领：想加第二个名字，从这里进来。 */}
                <form
                  className="stack gate-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault()
                    run(async () => {
                      await api.claim({ staffName: newStaffName })
                      setNewStaffName("")
                      await onRefresh()
                      onClose()
                    })
                  }}
                >
                  <label className="field">
                    新名字
                    <input
                      value={newStaffName}
                      autoComplete="off"
                      enterKeyHint="done"
                      onChange={(event) => setNewStaffName(event.target.value)}
                    />
                  </label>
                  <button className="secondary" type="submit" disabled={pending || !newStaffName.trim()}>
                    加名字并切换
                  </button>
                </form>
                <h3>常见搭配</h3>
                {pairingDraft ? (
                  <>
                    <p className="muted">
                      预览就是加项面板里那一排的样子。下面的芯片点一下去掉、再下面搜到点一下加入，改完记得保存。
                    </p>
                    <div className="pairing-sites">
                      {CHIEF_SITES.map((site) => (
                        <button
                          key={site}
                          type="button"
                          className={site === pairingSite ? "pairing-site is-on" : "pairing-site"}
                          onClick={() => {
                            setPairingSite(site)
                            setPairingQuery("")
                          }}
                        >
                          {targetById(site)?.name || site}
                        </button>
                      ))}
                    </div>
                    <p className="patient-label">预览</p>
                    {pairingDraft[pairingSite]?.length ? (
                      <PairingChips ids={pairingDraft[pairingSite]} />
                    ) : (
                      <p className="muted">这个部位不显示搭配。</p>
                    )}
                    <p className="patient-label">当前搭配 · 点一下去掉</p>
                    <PairingChips
                      ids={pairingDraft[pairingSite]}
                      disabled={pending}
                      onPick={(targetId) => {
                        setPairingDraft((draft) => ({
                          ...draft,
                          [pairingSite]: draft[pairingSite].filter((item) => item !== targetId),
                        }))
                      }}
                    />
                    <input
                      className="patient-search"
                      type="search"
                      value={pairingQuery}
                      placeholder="搜肌肉加入，可输拼音首字母"
                      aria-label="搜肌肉加入搭配"
                      onChange={(event) => setPairingQuery(event.target.value)}
                    />
                    {(() => {
                      const current = new Set(pairingDraft[pairingSite])
                      const ids = TARGETS.filter(
                        (target) =>
                          allowsWork(target) &&
                          !current.has(target.id) &&
                          matchesInitials(pairingQuery, target.name),
                      )
                        .slice(0, 30)
                        .map((target) => target.id)
                      return (
                        <PairingChips
                          ids={ids}
                          disabled={pending}
                          onPick={(targetId) => {
                            setPairingDraft((draft) => ({
                              ...draft,
                              [pairingSite]: [...draft[pairingSite], targetId].slice(0, 12),
                            }))
                          }}
                        />
                      )
                    })()}
                    <div className="today-template-buttons">
                      <button
                        type="button"
                        className="primary"
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            await api.savePairings(pairingDraft)
                            setPairingDraft(null)
                            await onRefresh()
                          })
                        }
                      >
                        保存搭配
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={pending}
                        onClick={() => setPairingDraft(structuredClone(DEFAULT_PAIRINGS))}
                      >
                        恢复默认
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={pending}
                        onClick={() => setPairingDraft(null)}
                      >
                        收起
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted">
                      要治的地方定了以后，加项面板会亮出一排这个部位常用的肌肉，点一下就加项。
                    </p>
                    <div className="today-template-buttons">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setPairingDraft(structuredClone(snap.pairings || DEFAULT_PAIRINGS))
                          setPairingQuery("")
                        }}
                      >
                        改搭配
                      </button>
                    </div>
                  </>
                )}
                {archivedPatients.length ? (
                  <>
                    <h3>已归档病人</h3>
                    <p className="muted">归档后不会出现在「加入已有病人」里，历史和今日单上的条目仍保留。</p>
                    <div className="patient-list">
                      {archivedPatients.map((patient) => (
                        <div key={patient.id} className="row-btn patient-row today-template-row">
                          <span className="patient-name">{patient.name}</span>
                          <button
                            type="button"
                            className="today-gear"
                            disabled={pending}
                            onClick={() =>
                              run(async () => {
                                await api.setPatientArchived(patient.id, false)
                                await onRefresh()
                              })
                            }
                          >
                            取消归档
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {templates.length ? (
                  <>
                    <h3>病症模板</h3>
                    <div className="patient-list">
                      {templates.map((template) => (
                        <div key={template.id} className="row-btn patient-row today-template-row">
                          <span className="patient-name">{template.name}</span>
                          <span className="patient-conds">{`${template.itemCount} 项`}</span>
                          <button
                            type="button"
                            className="today-gear"
                            disabled={pending}
                            onClick={() => {
                              if (!window.confirm(`删除模板「${template.name}」？确认后才会删掉。`)) return
                              run(async () => {
                                await api.deleteTemplate(template.id)
                                await onRefresh()
                              })
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                {equipmentTypes.length ? (
                  <details className="settings-equipment-ledger">
                    <summary>
                      <span className="settings-equipment-summary-title">设备台账</span>
                      <span className="settings-equipment-summary-meta">
                        {`${equipmentTypes.length} 类 · ${equipmentUnits.length} 台`}
                      </span>
                    </summary>
                    <p className="settings-equipment-note">
                      设备类型、机台和参数由系统目录统一管理；当前只读展示，暂不支持编辑。
                    </p>
                    <div className="settings-equipment-list">
                      {equipmentLedger.map(({ type, units, shared }) => (
                        <section key={type.id || type.name} className="settings-equipment-group">
                          <div className="settings-equipment-heading">
                            <span className="settings-equipment-name">
                              {type.name || type.shortName || type.id || "未命名设备"}
                            </span>
                            <span className={shared ? "settings-equipment-shared" : "settings-equipment-count"}>
                              {shared ? "共享" : `${units.length} 台`}
                            </span>
                          </div>
                          <p className="settings-equipment-units">
                            {units.length
                              ? units.map((unit) => unit.name || unit.id).join("、")
                              : shared
                                ? "共享设备，不占具体机台"
                                : "暂无具体机台"}
                          </p>
                        </section>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>,
      document.body,
    )
}
