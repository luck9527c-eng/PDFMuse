/** 整书批量扫描页序：从第 1 页线性推进（T57-02）。Reader 当前页的文字层由交互识别
 *  即时保证（当前页识别 + 邻页预取、识别池内插队），批量序不再从开书页向两侧扩散——
 *  目录探测窗口最先覆盖，目录时效与开书位置解耦。 */
export function linearPageOrder(totalPages: number) {
  if (!Number.isSafeInteger(totalPages) || totalPages <= 0) return [];
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}
