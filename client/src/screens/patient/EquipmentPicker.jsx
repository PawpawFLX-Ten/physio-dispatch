// 设备模式：从人体点中的 target/side 进入，点设备、机台或动作模板一次入库。
import { hasSides, targetById, targetTitle } from "@shared/catalog.js"
import { equipmentDefaultParameterSummary } from "./helpers.js"
import { Notice, Sheet } from "./ui.jsx"

function compatibleWith(row, targetId) {
  return !Array.isArray(row?.compatibleTargetIds) || row.compatibleTargetIds.includes(targetId)
}

// 按钮文字保持设备/机台/模板的纯名称：治疗师一眼能点，自动化回归也能按名字精确命中。
export function EquipmentPicker({
  targetId,
  side,
  equipmentTypes = [],
  equipmentUnits = [],
  exerciseTemplates = [],
  pending,
  notice,
  onAdd,
  onClose,
}) {
  const target = targetById(targetId)
  const title = targetTitle(targetId, side)
  const types = equipmentTypes.filter(
    (type) => type?.id && compatibleWith(type, targetId) && (!type.technique || type.technique === "equipment"),
  )
  const templates = exerciseTemplates.filter(
    (template) => template?.id && compatibleWith(template, targetId) && (!template.technique || template.technique === "equipment"),
  )
  const noChoices = types.length === 0 && templates.length === 0
  const missingSide = Boolean(target && hasSides(target) && !side)

  function addType(type, unit = null) {
    const extra = { equipmentTypeId: type.id }
    if (unit?.id) extra.equipmentUnitId = unit.id
    if (type.defaultParameters && Object.keys(type.defaultParameters).length) {
      extra.parameters = { ...type.defaultParameters }
    }
    const label = unit?.name ? `${type.name} · ${unit.name}` : type.name
    onAdd?.(extra, label)
  }

  function addTemplate(template) {
    // 服务端会按模板自动补设备类型、linkedTargets 和默认参数/组次，不在这里重复一份。
    onAdd?.({ exerciseTemplateId: template.id }, template.name)
  }

  return (
    <Sheet title="选择设备或动作" onClose={onClose}>
      <Notice notice={notice} />
      <div className="patient-equipment-current">
        <span className="patient-equipment-eyebrow">当前部位</span>
        <strong>{title}</strong>
        {target?.name && side ? <span className="patient-equipment-side">{side === "left" ? "左侧" : "右侧"}</span> : null}
      </div>
      {pending ? (
        <p className="patient-equipment-pending" role="status">
          正在入库…
        </p>
      ) : null}
      {missingSide ? (
        <p className="patient-notice is-error" role="alert">
          这个部位需要明确的左侧或右侧，请返回人体从侧边点选。
        </p>
      ) : null}
      {noChoices ? (
        <div className="patient-equipment-empty" role="status">
          <strong>这个部位没有兼容的设备或动作模板</strong>
          <span>可以切回手动模式，继续用按摩、松解或牵伸。</span>
        </div>
      ) : null}
      {types.length ? (
        <section className="patient-equipment-section" aria-label="兼容设备">
          <p className="patient-label">设备</p>
          <div className="patient-equipment-rail">
            {types.map((type) => {
              const units = equipmentUnits
                .filter((unit) => unit?.equipmentTypeId === type.id)
                .sort((left, right) => (left.order || 0) - (right.order || 0))
              const defaults = equipmentDefaultParameterSummary(type)
              return (
                <article key={type.id} className="patient-equipment-card">
                  <button
                    type="button"
                    className="patient-equipment-type"
                    disabled={pending || missingSide}
                    onClick={() => addType(type)}
                  >
                    {type.name}
                  </button>
                  <p className="patient-equipment-meta">
                    {[type.categoryLabel || (type.requiresUnit ? "设备" : "共享设备"), units.length ? `${units.length} 台可选` : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {units.length ? (
                    <div className="patient-equipment-units">
                      {units.map((unit) => (
                        <button
                          key={unit.id}
                          type="button"
                          className="patient-equipment-unit"
                          disabled={pending || missingSide}
                          onClick={() => addType(type, unit)}
                        >
                          {unit.name}
                        </button>
                      ))}
                    </div>
                  ) : type.requiresUnit === false ? (
                    <p className="patient-equipment-shared">共享设备，不占机台</p>
                  ) : (
                    <p className="patient-equipment-shared">机台自动安排</p>
                  )}
                  {defaults ? <p className="patient-equipment-params">{`默认：${defaults}`}</p> : null}
                </article>
              )
            })}
          </div>
        </section>
      ) : null}
      {templates.length ? (
        <section className="patient-equipment-section" aria-label="动作模板">
          <p className="patient-label">动作模板</p>
          <div className="patient-equipment-rail is-templates">
            {templates.map((template) => {
              const type = equipmentTypes.find((row) => row.id === template.equipmentTypeId)
              const dose = template.defaultDose
                ? `${template.defaultDose.sets || 0} 组 × ${template.defaultDose.reps || 0} 次`
                : ""
              return (
                <article key={template.id} className="patient-equipment-card is-template">
                  <button
                    type="button"
                    className="patient-equipment-template"
                    disabled={pending || missingSide}
                    onClick={() => addTemplate(template)}
                  >
                    {template.name}
                  </button>
                  <p className="patient-equipment-meta">{type?.name || "共享设备"}</p>
                  {dose ? <p className="patient-equipment-params">{`默认：${dose}`}</p> : null}
                </article>
              )
            })}
          </div>
        </section>
      ) : null}
      <button type="button" className="secondary" onClick={onClose}>
        关闭
      </button>
    </Sheet>
  )
}
