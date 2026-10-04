/**
 * <DispatchStateTag> 送检登记状态徽标（运维班 / 计量站两侧共用）。
 */
import { Tag, Tooltip } from 'antd';
import { DISPATCH_STATE_COLORS, DISPATCH_STATE_HINTS, type DispatchState } from '@/types/dispatch';

export interface DispatchStateTagProps {
  state: DispatchState;
  /** 是否附悬停说明 */
  withTip?: boolean;
}

export function DispatchStateTag({ state, withTip = true }: DispatchStateTagProps) {
  const tag = (
    <Tag
      color={DISPATCH_STATE_COLORS[state]}
      style={{ borderRadius: 999, marginInlineEnd: 0, fontWeight: 600 }}
    >
      {state}
    </Tag>
  );
  return withTip ? <Tooltip title={DISPATCH_STATE_HINTS[state]}>{tag}</Tooltip> : tag;
}

export default DispatchStateTag;
