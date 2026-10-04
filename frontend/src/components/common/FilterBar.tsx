/**
 * <FilterBar> 关键字 + 多选条件过滤组件，条件变化同步 URL query。
 * 被台阵台账（/arrays）与标定记录台（/calibrations）消费。
 */
import { Button, Checkbox, DatePicker, Input, InputNumber, Select, Space, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { FilterModel } from '@/types/filter';

export interface FilterSelectOption {
  label: string;
  value: string;
}

export interface FilterSelectConfig {
  key: string;
  label: string;
  options: FilterSelectOption[];
  placeholder?: string;
  multiple?: boolean;
}

export interface FilterRangeConfig {
  key: string;
  label: string;
  placeholder?: string;
  suffix?: string;
}

export interface FilterDateConfig {
  key: string;
  label: string;
}

export interface FilterBarProps {
  modelValue: FilterModel;
  selects?: FilterSelectConfig[];
  numberRanges?: FilterRangeConfig[];
  dateRanges?: FilterDateConfig[];
  keywordPlaceholder?: string;
  hasSwitch?: boolean;
  switchLabel?: string;
  switchValue?: boolean;
  showReset?: boolean;
  onChange: (next: FilterModel, switchValue: boolean) => void;
  onReset: () => void;
  /** 右侧附加操作区 */
  extra?: React.ReactNode;
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function FilterBar({
  modelValue,
  selects = [],
  numberRanges = [],
  dateRanges = [],
  keywordPlaceholder = '搜索关键字…',
  hasSwitch = false,
  switchLabel = '',
  switchValue = false,
  showReset = true,
  onChange,
  onReset,
  extra,
}: FilterBarProps) {
  const activeCount =
    selects.reduce((sum, select) => sum + toArray((modelValue as Record<string, unknown>)[select.key]).length, 0) +
    numberRanges.reduce(
      (sum, range) => sum + (toNumberOrNull((modelValue as Record<string, unknown>)[range.key]) === null ? 0 : 1),
      0
    ) +
    dateRanges.reduce((sum, range) => {
      const value = (modelValue as Record<string, unknown>)[range.key];
      return sum + (typeof value === 'string' && value.length > 0 ? 1 : 0);
    }, 0) +
    (hasSwitch && switchValue ? 1 : 0);

  const emit = (patch: Record<string, unknown>, nextSwitch = switchValue) => {
    onChange({ ...modelValue, ...patch } as FilterModel, nextSwitch);
  };

  const handleReset = () => {
    onReset();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '14px 16px',
        background: '#ffffff',
        border: '1px solid #dbe4ee',
        borderRadius: 10,
      }}
    >
      <Space wrap size={12} style={{ flex: '1 1 520px' }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          style={{ width: 220 }}
          placeholder={keywordPlaceholder}
          value={modelValue.keyword}
          onChange={(event) => emit({ keyword: event.target.value })}
        />

        {selects.map((select) => (
          <Space key={select.key} size={6}>
            <span style={{ fontSize: 13, color: '#5b6b78' }}>{select.label}</span>
            <Select
              mode={select.multiple === false ? undefined : 'multiple'}
              allowClear
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              style={{ minWidth: 180 }}
              placeholder={select.placeholder ?? `选择${select.label}`}
              value={
                select.multiple === false
                  ? (modelValue as Record<string, string | undefined>)[select.key] || undefined
                  : toArray((modelValue as Record<string, unknown>)[select.key])
              }
              options={select.options}
              onChange={(value) => emit({ [select.key]: value ?? (select.multiple === false ? '' : []) })}
            />
          </Space>
        ))}

        {numberRanges.map((range) => (
          <Space key={range.key} size={6}>
            <span style={{ fontSize: 13, color: '#5b6b78' }}>{range.label}</span>
            <InputNumber
              style={{ width: 110 }}
              placeholder={range.placeholder ?? '不限'}
              value={toNumberOrNull((modelValue as Record<string, unknown>)[range.key])}
              onChange={(value) => emit({ [range.key]: value ?? null })}
              addonAfter={range.suffix}
            />
          </Space>
        ))}

        {dateRanges.map((range) => (
          <Space key={range.key} size={6}>
            <span style={{ fontSize: 13, color: '#5b6b78' }}>{range.label}</span>
            <DatePicker
              style={{ width: 150 }}
              placeholder="选择日期"
              value={
                typeof (modelValue as Record<string, unknown>)[range.key] === 'string' &&
                ((modelValue as Record<string, string>)[range.key] ?? '').length > 0
                  ? dayjs((modelValue as Record<string, string>)[range.key])
                  : null
              }
              onChange={(date) => emit({ [range.key]: date ? date.format('YYYY-MM-DD') : '' })}
            />
          </Space>
        ))}

        {hasSwitch ? (
          <Checkbox checked={switchValue} onChange={(event) => emit({}, event.target.checked)}>
            {switchLabel}
          </Checkbox>
        ) : null}
      </Space>

      <Space size={8}>
        {extra}
        {activeCount > 0 ? (
          <Tag color="orange" style={{ borderRadius: 999 }}>
            {activeCount} 项条件
          </Tag>
        ) : null}
        {showReset ? (
          <Button type="link" icon={<ReloadOutlined />} onClick={handleReset}>
            重置
          </Button>
        ) : null}
      </Space>
    </div>
  );
}

export default FilterBar;
