// 活动设备项的参数与机台编辑：只改当前设备，不允许在这里换设备/动作模板。
import { useState } from "react"
import {
  buildEquipmentParameterDraft,
  equipmentParameterDraftState,
  equipmentParameterFields,
  equipmentStartedText,
} from "./helpers.js"

function optionValue(option) {
  return typeof option === "string" ? option : option.value
}

function optionLabel(option) {
  return typeof option === "string" ? option : option.label || option.value
}

export function EquipmentEditor({
  item,
  type,
  units = [],
  linkedTitles = [],
  pending,
  onSaveParameters,
  onSelectUnit,
  onSetStarted,
  onRequestReplace,
}) {
  const fields = equipmentParameterFields(type)
  // 父层以参数快照作 key；保存成功/外部改动会重挂并刷新草稿，改派工/机台不会丢本地编辑。
  const [draft, setDraft] = useState(() => buildEquipmentParameterDraft(item, type))
  const state = equipmentParameterDraftState(item, type, draft)
  const typeUnits = units
    .filter((unit) => unit?.equipmentTypeId === type?.id)
    .sort((left, right) => (left.order || 0) - (right.order || 0))
  const currentUnitId = item.equipmentUnitId || ""
  const currentUnit = typeUnits.find((unit) => unit.id === currentUnitId) || null
  const currentUnitName = item.equipmentUnitName || currentUnit?.name || ""
  const started = Boolean(item.startedAt)
  const startedText = equipmentStartedText(item)
  const deviceName = type?.name || item.equipmentTypeName || item.equipmentSummary || "设备"

  function updateField(field, value) {
    setDraft((current) => ({ ...current, [field.key]: value }))
  }

  function saveParameters() {
    if (pending || state.invalid || !state.changed || !state.values) return
    onSaveParameters?.(state.values)
  }

  function submitParameters(event) {
    event.preventDefault()
    saveParameters()
  }

  return (
    <section className="patient-equipment-editor" aria-label="设备信息与参数编辑">
      <header className="patient-equipment-editor-head">
        <p className="patient-equipment-eyebrow">设备信息</p>
        <h3>{deviceName}</h3>
        <dl>
          <div>
            <dt>模板</dt>
            <dd>{item.exerciseName || "未使用动作模板"}</dd>
          </div>
          <div>
            <dt>关联</dt>
            <dd>{linkedTitles.length ? linkedTitles.join(" · ") : "仅主部位"}</dd>
          </div>
        </dl>
      </header>

      <section className={started && !item.done ? "patient-equipment-usage is-running" : "patient-equipment-usage"} aria-label="设备使用状态">
        <p className="patient-label">使用状态</p>
        {item.done ? (
          <p className="patient-equipment-note">已完成，设备已释放。</p>
        ) : started ? (
          <div className="patient-equipment-usage-row">
            <div className="patient-equipment-usage-copy">
              <p className="patient-equipment-usage-state">
                <span className="patient-in-use-badge">使用中</span>
                <span>{` · ${startedText}`}</span>
              </p>
              {type?.requiresUnit && currentUnitName ? (
                <p className="patient-equipment-usage-unit">{`机台：${currentUnitName}`}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="secondary patient-equipment-usage-btn"
              disabled={pending}
              onClick={() => onSetStarted?.(false)}
            >
              结束使用
            </button>
          </div>
        ) : (
          <div className="patient-equipment-usage-start">
            {type?.requiresUnit && currentUnitName ? (
              <p className="patient-equipment-usage-unit">{`机台：${currentUnitName}`}</p>
            ) : null}
            <button
              type="button"
              className="primary patient-equipment-usage-btn"
              disabled={pending}
              onClick={() => onSetStarted?.(true)}
            >
              开始使用设备
            </button>
          </div>
        )}
      </section>

      {fields.length ? (
        <form className="patient-equipment-parameter-form" onSubmit={submitParameters}>
          <p className="patient-label">参数</p>
          <div className="patient-equipment-fields">
            {state.fields.map((field) => {
              const label = `${field.label}${field.unit ? `（${field.unit}）` : ""}`
              if (field.type === "select") {
                return (
                  <label key={field.key} className="patient-equipment-field">
                    <span>{label}</span>
                    <select
                      value={draft[field.key] ?? ""}
                      disabled={pending}
                      onChange={(event) => updateField(field, event.target.value)}
                    >
                      {(field.options || []).map((option) => (
                        <option key={String(optionValue(option))} value={optionValue(option)}>
                          {optionLabel(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              }
              if (field.type === "number") {
                return (
                  <label key={field.key} className="patient-equipment-field">
                    <span>{label}</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={draft[field.key] ?? ""}
                      disabled={pending}
                      onChange={(event) => updateField(field, event.target.value)}
                    />
                  </label>
                )
              }
              return null
            })}
          </div>
          {state.invalid ? (
            <p className="patient-equipment-error" role="alert">
              请填写有效的参数值
            </p>
          ) : null}
          <button
            type="button"
            className="primary patient-equipment-save"
            disabled={pending || state.invalid || !state.changed}
            onClick={saveParameters}
          >
            保存参数
          </button>
          {!state.changed && !state.invalid ? (
            <p className="patient-equipment-note">参数未改动，不会重复保存。</p>
          ) : null}
        </form>
      ) : (
        <p className="patient-equipment-note">这类设备没有可编辑参数。</p>
      )}

      <div className="patient-equipment-unit-editor">
        <p className="patient-label">机台</p>
        {!type ? (
          <p className="patient-equipment-note">设备目录未加载，机台暂不可切换。</p>
        ) : type.requiresUnit ? (
          typeUnits.length ? (
            <div className="patient-equipment-unit-choices">
              <button
                type="button"
                className={currentUnitId ? "patient-equipment-unit-choice" : "patient-equipment-unit-choice is-on"}
                aria-pressed={!currentUnitId}
                disabled={pending}
                onClick={() => {
                  if (currentUnitId) onSelectUnit?.("")
                }}
              >
                自动
              </button>
              {typeUnits.map((unit) => (
                <button
                  type="button"
                  key={unit.id}
                  className={currentUnitId === unit.id ? "patient-equipment-unit-choice is-on" : "patient-equipment-unit-choice"}
                  aria-pressed={currentUnitId === unit.id}
                  disabled={pending}
                  onClick={() => {
                    if (currentUnitId !== unit.id) onSelectUnit?.(unit.id)
                  }}
                >
                  {unit.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="patient-equipment-note">自动（暂无可用机台配置）</p>
          )
        ) : (
          <p className="patient-equipment-note">共享，不占机台</p>
        )}
      </div>

      <button
        type="button"
        className="secondary patient-equipment-replace-btn"
        disabled={pending || item.done || Boolean(item.startedAt)}
        onClick={() => onRequestReplace?.()}
      >
        更换设备或动作
      </button>
      <p className="patient-equipment-editor-hint">
        {item.done ? "已完成的任务不能更换。" : item.startedAt ? "结束使用后才能更换。" : "原位替换，任务顺序和派工保持不变。"}
      </p>
    </section>
  )
}
