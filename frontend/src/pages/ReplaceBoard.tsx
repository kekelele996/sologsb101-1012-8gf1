/**
 * 模块 4：/replacements 合格评定与更换提醒
 * 超期未标定仪器高亮、按标定结论登记更换并跟踪状态机到复核闭环。
 * 复用 <StatBadge>、<QualifyTag>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, WarningFilled } from '@ant-design/icons';
import dayjs from 'dayjs';
import FilterBar from '@/components/common/FilterBar';
import type { FilterModel } from '@/types/filter';
import StatBadge from '@/components/common/StatBadge';
import QualifyTag from '@/components/common/QualifyTag';
import EmptyPanel from '@/components/common/EmptyPanel';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  createReplace,
  patchReplaceFilter,
  removeReplace,
  resetReplaceFilter,
  selectCalibrations,
  selectReplaceFilter,
  selectReplaces,
  transitionReplace,
  updateReplace,
} from '@/stores/calibrationSlice';
import {
  REPLACE_REASON_TEMPLATES,
  REPLACE_STATES,
  REPLACE_TRANSITIONS,
  type Replace,
  type ReplaceState,
} from '@/types/replace';
import { daysUntilDue, type Instrument } from '@/types/instrument';
import { useCalibHistory } from '@/hooks/useCalibHistory';
import { initDatabase } from '@/utils/db';

interface ReplaceFormValues {
  instrumentId: string;
  reason: string;
  newSerialNo: string;
  date: dayjs.Dayjs | null;
  state: ReplaceState;
  operator: string;
  remark: string;
}

/** 仪器评定行：标定结论、待标定天数与更换状态 */
interface AssessmentRow {
  instrument: Instrument;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  lastDate: string;
  dueInDays: number;
  overdue: boolean;
  lastVerdict: string;
  calibrationCount: number;
  replace: Replace | null;
}

export default function ReplaceBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const instruments = useAppSelector(selectInstruments);
  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);
  const filter = useAppSelector(selectReplaceFilter);
  const { histories } = useCalibHistory();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ReplaceFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  /** 仪器评定行：结合标定结论与更换记录 */
  const rows = useMemo<AssessmentRow[]>(() => {
    return instruments
      .map((instrument) => {
        const station = stations.find((row) => row.id === instrument.stationId);
        const array = station ? arrays.find((row) => row.id === station.arrayId) : undefined;
        const own = calibrations
          .filter((row) => row.instrumentId === instrument.id)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = own[0];
        const lastDate = latest ? latest.date : instrument.installDate;
        const dueInDays = daysUntilDue(lastDate, instrument.installDate);
        const replace =
          replaces
            .filter((row) => row.instrumentId === instrument.id)
            .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
        return {
          instrument,
          stationCode: station?.code ?? '未知台站',
          arrayId: array?.id ?? '',
          arrayName: array?.name ?? '未知台阵',
          lastDate,
          dueInDays,
          overdue: dueInDays < 0,
          lastVerdict: latest ? latest.responseVerdict : '待判定',
          calibrationCount: own.length,
          replace,
        };
      })
      .filter((row) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${row.instrument.model}${row.instrument.serialNo}${row.stationCode}${row.arrayName}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.arrayIds.length > 0 && !filter.arrayIds.includes(row.arrayId)) return false;
        if (filter.states.length > 0) {
          const state = row.replace?.state ?? '待更换';
          if (!filter.states.includes(state)) return false;
        }
        return true;
      })
      .sort((a, b) => a.dueInDays - b.dueInDays);
  }, [arrays, calibrations, filter, instruments, replaces, stations]);

  const totals = useMemo(() => {
    const overdue = rows.filter((row) => row.overdue).length;
    const unqualified = rows.filter((row) => row.lastVerdict === '不合格').length;
    const pendingReplace = replaces.filter((row) => row.state === '待更换').length;
    const closedReplace = replaces.filter((row) => row.state === '已复核').length;
    const cycleRate =
      rows.length === 0 ? 0 : Number((((rows.length - overdue) / rows.length) * 100).toFixed(1));
    return { instruments: rows.length, overdue, unqualified, pendingReplace, closedReplace, cycleRate };
  }, [replaces, rows]);

  const replaceRows = useMemo(
    () =>
      replaces
        .map((row) => {
          const instrument = instruments.find((item) => item.id === row.instrumentId);
          const station = instrument ? stations.find((item) => item.id === instrument.stationId) : undefined;
          const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
          return { row, instrument, stationCode: station?.code ?? '—', arrayName: array?.name ?? '—' };
        })
        .sort((a, b) => b.row.date.localeCompare(a.row.date)),
    [arrays, instruments, replaces, stations]
  );

  const filterModel: FilterModel = {
    keyword: filter.keyword,
    states: filter.states,
    arrayIds: filter.arrayIds,
  };

  const openCreate = (instrumentId?: string) => {
    setEditingId(null);
    const defaultReason = REPLACE_REASON_TEMPLATES[0].reason;
    form.setFieldsValue({
      instrumentId: instrumentId ?? instruments[0]?.id ?? '',
      reason: defaultReason,
      newSerialNo: '',
      date: dayjs(),
      state: '待更换',
      operator: '周渝',
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (row: Replace) => {
    setEditingId(row.id);
    form.setFieldsValue({
      instrumentId: row.instrumentId,
      reason: row.reason,
      newSerialNo: row.newSerialNo,
      date: dayjs(row.date),
      state: row.state,
      operator: row.operator,
      remark: row.remark,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        instrumentId: values.instrumentId,
        reason: values.reason.trim(),
        newSerialNo: values.newSerialNo.trim(),
        date: values.date ? values.date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
        state: values.state,
        operator: values.operator.trim(),
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        await dispatch(updateReplace({ id: editingId, patch: payload })).unwrap();
        message.success('更换记录已更新');
      } else {
        await dispatch(createReplace(payload)).unwrap();
        message.success('更换记录已登记，可在下方推进状态机');
      }
      setModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const advance = async (row: Replace, next: ReplaceState) => {
    try {
      await dispatch(transitionReplace({ id: row.id, next })).unwrap();
      message.success(
        next === '已更换'
          ? '更换完成：已回写仪器序列号并置为在用，旧记录已归档'
          : `更换记录状态已流转到「${next}」`
      );
    } catch (error) {
      message.error(typeof error === 'string' ? error : '状态流转失败');
    }
  };

  const handleFilterChange = (next: FilterModel) => {
    dispatch(
      patchReplaceFilter({
        keyword: next.keyword,
        states: ((next.states as string[]) ?? []) as ReplaceState[],
        arrayIds: (next.arrayIds as string[]) ?? [],
      })
    );
  };

  /** 超期仪器提醒（标定周期 365 天） */
  const overdueHistories = histories.filter((history) => history.overdue);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            合格评定与更换提醒
          </Typography.Title>
          <p className="gb-hint">
            按标定周期（365 天）与脉冲响应结论评定仪器是否合格；超期未标定与不合格仪器高亮提示，可直接登记更换并跟踪到复核闭环。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
          登记更换
        </Button>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="仪器台数" value={totals.instruments} suffix="台" tone="primary" />
        <StatBadge
          label="超期未标定"
          value={totals.overdue}
          suffix="台"
          tone={totals.overdue > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="结论不合格"
          value={totals.unqualified}
          suffix="台"
          tone={totals.unqualified > 0 ? 'warning' : 'success'}
        />
        <StatBadge label="按期标定率" value={totals.cycleRate} percent={totals.cycleRate} tone="success" />
        <StatBadge label="待更换" value={totals.pendingReplace} suffix="条" tone="warning" />
        <StatBadge label="已复核" value={totals.closedReplace} suffix="条" tone="info" />
      </div>

      {overdueHistories.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<WarningFilled />}
          message={`存在 ${overdueHistories.length} 台超期未标定仪器，请优先安排标定或登记更换`}
          description={overdueHistories
            .slice(0, 5)
            .map(
              (history) =>
                `${history.arrayName} / ${history.stationCode} · ${history.instrument.model}（${history.instrument.serialNo}）已超期 ${Math.abs(history.dueInDays)} 天`
            )
            .join('；')}
        />
      ) : (
        <Alert type="success" showIcon message="全部仪器均在标定周期内，无需特别提醒" />
      )}

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'states',
            label: '更换状态',
            options: REPLACE_STATES.map((state) => ({ label: state, value: state })),
          },
          {
            key: 'arrayIds',
            label: '所属台阵',
            options: arrays.map((array) => ({ label: array.name, value: array.id })),
          },
        ]}
        keywordPlaceholder="搜索型号 / 序列号 / 台站 / 台阵"
        onChange={handleFilterChange}
        onReset={() => dispatch(resetReplaceFilter())}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={instruments.length === 0 ? '还没有仪器' : '没有符合条件的仪器'}
          description="先到「台站仪器」页登记仪器并录入标定结果，再回到本页进行合格评定与更换跟踪。"
          actionText="登记更换"
          secondaryText="重置筛选"
          onAction={() => openCreate()}
          onSecondary={() => dispatch(resetReplaceFilter())}
        />
      ) : (
        <Table
          rowKey={(row) => row.instrument.id}
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          rowClassName={(row) => (row.overdue || row.lastVerdict === '不合格' ? 'gb-row-danger' : '')}
          columns={[
            {
              title: '仪器',
              width: 210,
              render: (_: unknown, row: AssessmentRow) => (
                <div>
                  <div>
                    {row.instrument.model} <Tag>{row.instrument.type}</Tag>
                  </div>
                  <div className="gb-hint gb-mono">{row.instrument.serialNo}</div>
                </div>
              ),
            },
            {
              title: '台站 / 台阵',
              width: 180,
              render: (_: unknown, row: AssessmentRow) => (
                <div>
                  <div className="gb-mono">{row.stationCode}</div>
                  <div className="gb-hint">{row.arrayName}</div>
                </div>
              ),
            },
            {
              title: '最近标定',
              width: 130,
              render: (_: unknown, row: AssessmentRow) => (
                <div>
                  <div className="gb-mono">{row.lastDate}</div>
                  <div className="gb-hint">{row.calibrationCount} 次记录</div>
                </div>
              ),
            },
            {
              title: '标定提醒',
              width: 160,
              render: (_: unknown, row: AssessmentRow) => (
                <span className={row.overdue ? 'gb-danger gb-mono' : 'gb-mono'}>
                  {row.overdue ? `超期 ${Math.abs(row.dueInDays)} 天` : `剩余 ${row.dueInDays} 天`}
                </span>
              ),
            },
            {
              title: '标定结论',
              width: 150,
              render: (_: unknown, row: AssessmentRow) => <QualifyTag verdict={row.lastVerdict as never} size="small" />,
            },
            {
              title: '仪器状态',
              width: 110,
              render: (_: unknown, row: AssessmentRow) => (
                <Tag color={row.instrument.state === '在用' ? 'green' : row.instrument.state === '待标定' ? 'orange' : 'default'}>
                  {row.instrument.state}
                </Tag>
              ),
            },
            {
              title: '更换状态',
              width: 150,
              render: (_: unknown, row: AssessmentRow) =>
                row.replace ? (
                  <div>
                    <Tag color={row.replace.state === '已复核' ? 'green' : row.replace.state === '已更换' ? 'blue' : 'orange'}>
                      {row.replace.state}
                    </Tag>
                    <div className="gb-hint">{row.replace.date}</div>
                  </div>
                ) : (
                  <span className="gb-hint">未登记更换</span>
                ),
            },
            {
              title: '操作',
              width: 260,
              render: (_: unknown, row: AssessmentRow) => (
                <Space size={6}>
                  <Button size="small" type="primary" onClick={() => openCreate(row.instrument.id)}>
                    登记更换
                  </Button>
                  {row.replace ? (
                    <>
                      {(REPLACE_TRANSITIONS[row.replace.state] ?? []).slice(0, 1).map((next) => (
                        <Button key={next} size="small" onClick={() => void advance(row.replace as Replace, next)}>
                          → {next}
                        </Button>
                      ))}
                      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row.replace as Replace)}>
                        编辑
                      </Button>
                    </>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      )}

      <Card className="gb-panel" size="small" title={`更换记录跟踪（${replaceRows.length} 条）`}>
        {replaceRows.length === 0 ? (
          <EmptyPanel
            title="还没有更换记录"
            description="对超期或不合格仪器点击「登记更换」，即可跟踪到复核闭环。"
            actionText="登记更换"
            onAction={() => openCreate()}
            compact
          />
        ) : (
          <Table
            rowKey={(item) => item.row.id}
            size="small"
            className="gb-table-compact"
            dataSource={replaceRows}
            pagination={false}
            columns={[
              {
                title: '仪器',
                width: 200,
                render: (_: unknown, item) => (
                  <div>
                    <div>{item.instrument?.model ?? '仪器已删除'}</div>
                    <div className="gb-hint gb-mono">{item.row.newSerialNo || '未填新序列号'}</div>
                  </div>
                ),
              },
              {
                title: '台站 / 台阵',
                width: 160,
                render: (_: unknown, item) => (
                  <div>
                    <div className="gb-mono">{item.stationCode}</div>
                    <div className="gb-hint">{item.arrayName}</div>
                  </div>
                ),
              },
              { title: '更换原因', dataIndex: ['row', 'reason'], ellipsis: true },
              { title: '日期', dataIndex: ['row', 'date'], width: 120, className: 'gb-mono' },
              {
                title: '状态',
                width: 130,
                render: (_: unknown, item) => (
                  <Tag color={item.row.state === '已复核' ? 'green' : item.row.state === '已更换' ? 'blue' : 'orange'}>
                    {item.row.state}
                  </Tag>
                ),
              },
              { title: '责任人', dataIndex: ['row', 'operator'], width: 100 },
              {
                title: '操作',
                width: 280,
                render: (_: unknown, item) => (
                  <Space size={6}>
                    {(REPLACE_TRANSITIONS[item.row.state] ?? []).map((next) => (
                      <Button key={next} size="small" onClick={() => void advance(item.row, next)}>
                        → {next}
                      </Button>
                    ))}
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item.row)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除更换记录"
                      description="确认删除该更换记录？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeReplace(item.row.id))
                          .unwrap()
                          .then(() => message.success('更换记录已删除'))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <p className="gb-hint">
        更换完成后点击「→ 已更换」，系统会把新序列号回写到仪器档案并置为在用；再流转到「已复核」即完成闭环。
        前往
        <Button type="link" size="small" onClick={() => navigate(ROUTES.calibrations)}>
          出车批次与对账
        </Button>
        可查看已对账结论与历次灵敏度趋势。
      </p>

      <Modal
        open={modalOpen}
        title={editingId ? '编辑更换记录' : '登记更换'}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editingId ? '保存修改' : '登记更换'}
        width={620}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="instrumentId" label="被更换仪器" rules={[{ required: true, message: '请选择仪器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={instruments.map((instrument) => {
                const station = stations.find((row) => row.id === instrument.stationId);
                return {
                  label: `${station?.code ?? ''} · ${instrument.model}（${instrument.serialNo}）`,
                  value: instrument.id,
                };
              })}
            />
          </Form.Item>
          <Form.Item name="reason" label="更换原因" rules={[{ required: true, message: '请填写更换原因' }]}>
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
          <Space wrap style={{ marginBottom: 12 }}>
            <span className="gb-hint">原因模板：</span>
            {REPLACE_REASON_TEMPLATES.map((template) => (
              <Button key={template.key} size="small" onClick={() => form.setFieldValue('reason', template.reason)}>
                {template.reason.slice(0, 10)}…
              </Button>
            ))}
          </Space>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="newSerialNo" label="新序列号" rules={[{ required: true, message: '请填写新序列号' }]}>
                <Input maxLength={60} placeholder="如：CMG-3E-20250410-33" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="date" label="更换日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="state" label="状态" rules={[{ required: true }]}>
                <Select options={REPLACE_STATES.map((state) => ({ label: state, value: state }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="责任人" rules={[{ required: true, message: '请填写责任人' }]}>
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：新仪器已到货，待停电窗口安装" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
