import { buildDaily, buildHeatmap, buildHourly, mockDlpByType, mockSavings } from './dashboardMock'

const delay = (ms = 400) => new Promise((r) => setTimeout(r, ms))

// Later: replace each body with an axios call. The return shapes stay the same.
export async function getDailySeries() {
  await delay()
  return buildDaily()
}
export async function getHeatmap() {
  await delay()
  return buildHeatmap()
}
export async function getSavings() {
  await delay()
  return mockSavings
}
export async function getHourlyTraffic() {
  await delay()
  return buildHourly()
}
export async function getDlpByType() {
  await delay()
  return mockDlpByType
}