// 病症模板：存一套手法、一键套用。
import { assertExpectedVersion, fail, id } from "./helpers.js"
import { instructionFields, remapPlanSide } from "../shared/workflow.js"


function equipmentFieldsOf(item) {
  return {
    ...instructionFields(item),
    equipmentTypeId: typeof item?.equipmentTypeId === "string" ? item.equipmentTypeId : null,
    equipmentUnitId: typeof item?.equipmentUnitId === "string" ? item.equipmentUnitId : null,
    exerciseTemplateId: typeof item?.exerciseTemplateId === "string" ? item.exerciseTemplateId : null,
    parameters:
      item?.parameters && typeof item.parameters === "object" && !Array.isArray(item.parameters)
        ? structuredClone(item.parameters)
        : {},
    linkedTargets: Array.isArray(item?.linkedTargets) ? structuredClone(item.linkedTargets) : [],
  }
}

export const templateMethods = {
  templateById(templateId) {
    return this.state.templates.find((item) => item.id === templateId) || null
  },

  // 把病人页今天调好的这套存成模板。取的是今天的链，不是病症里存的旧链。
  saveTemplateFromEntry({ deviceId, entryId, conditionId, name, shortName }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const patient = this.patient(entry.patientId)
    const wanted =
      conditionId && entry.conditionIds.includes(conditionId) ? conditionId : entry.conditionIds[entry.conditionIds.length - 1]
    const condition = this.condition(patient, wanted)
    if (!condition) fail(404, "找不到病症")
    const mine = entry.items.filter((item) => item.conditionId === wanted)
    if (!mine.length) fail(400, "这条病症今天还没有内容")
    const template = {
      id: id(),
      name: name?.trim() || condition.name,
      shortName: typeof shortName === "string" ? shortName.trim().slice(0, 40) : "",
      sequential: Boolean(entry.sequential),
      chiefSiteId: entry.conditionIds.length === 1 ? entry.chiefSiteId : condition.chiefSiteId,
      chiefSide: entry.conditionIds.length === 1 ? entry.chiefSide : condition.chiefSide || null,
      items: mine.map((item) => ({
        id: id(),
        targetId: item.targetId,
        side: item.side || null,
        technique: item.technique,
        direction: item.direction,
        dose: structuredClone(item.dose),
        ...equipmentFieldsOf(item),
      })),
    }
    this.state.templates.push(template)
    this.save()
    this.audit(deviceId, "存为模板", { 模板: template.name, 项数: template.items.length })
    return this.view(deviceId)
  },

  deleteTemplate({ deviceId, templateId }) {
    this.requireStaff(deviceId)
    const next = this.state.templates.filter((item) => item.id !== templateId)
    if (next.length === this.state.templates.length) fail(404, "找不到这个模板")
    this.state.templates = next
    this.save()
    this.audit(deviceId, "删除模板")
    return this.view(deviceId)
  },

  conditionFromTemplate(template, side) {
    if (side && !["left", "right", "both"].includes(side)) fail(400, "侧别不对")
    template = remapPlanSide(template, side)
    return {
      id: id(),
      name: template.name,
      chiefSiteId: template.chiefSiteId || null,
      chiefSide: template.chiefSide || null,
      fresh: false,
      sequential: Boolean(template.sequential),
      items: template.items.map((item) => ({
        id: id(),
        targetId: item.targetId,
        side: item.side || null,
        technique: item.technique,
        direction: item.direction,
        dose: structuredClone(item.dose),
        ...equipmentFieldsOf(item),
      })),
    }
  },

  createPatientFromTemplate({ deviceId, name, templateId, side }) {
    this.requireStaff(deviceId)
    const template = this.templateById(templateId)
    if (!template) fail(404, "找不到这个模板")
    if (!name?.trim()) fail(400, "请填写病人姓名")
    const condition = this.conditionFromTemplate(template, side)
    const patient = { id: id(), name: name.trim(), conditions: [condition] }
    this.state.patients.push(patient)
    const entry = this.makeEntry(patient, [condition.id], condition.id)
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "从模板建档", { 病人: patient.name, 模板: template.name })
    return this.entryView(deviceId, entry.id)
  },

  // 老病人来了新毛病：从模板生成一条病症，直接挂进今天这张单。
  applyTemplateToEntry({ deviceId, entryId, templateId, side, mode, expectedVersion }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    const patient = this.patient(entry.patientId)
    const template = this.templateById(templateId)
    if (!template) fail(404, "找不到这个模板")
    const condition = this.conditionFromTemplate(template, side)
    if (mode === "today") {
      // 今日复用只追加到当前病症，不把每次套方案都写成一个新诊断。
      const result = this.quickAdd({ deviceId, entryId, expectedVersion,
        chief: { targetId: condition.chiefSiteId, side: condition.chiefSide },
        items: condition.items.map((item) => {
          const input = { ...item }
          if (input.technique !== "equipment") {
            delete input.parameters
            delete input.linkedTargets
          }
          return input
        }),
      })
      return result
    }
    patient.conditions.push(condition)
    this.attachCondition(entry, patient, condition.id)
    this.save()
    this.audit(deviceId, "模板加入今天", { 病人: patient.name, 模板: template.name })
    return this.entryView(deviceId, entry.id)
  },
}
