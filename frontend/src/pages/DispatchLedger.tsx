/**
 * 运维班送检台账（/dispatches）
 * 按台站记仪器安装位置与送检登记：这趟带了哪几台、哪些台站还没轮到都可查。
 * - 登记时自动占名额排入最早一趟待出车批次，名额满了排队等下一趟；
 * - 与计量站出车批次按台站码 + 序列号对账，对不上的挂起等确认，不写结论；
 * - 对账失败后按运维班安装位置台账刷新重试；计量站退回只退这一台。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
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
  Timeline,
  Typography,
} from 'antd';
import {
  CarOutlined,
  DeleteOutlined,
  PlusOutlined,
  RedoOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar from '@/components/common/FilterBar';
import DispatchStateTag from '@/components/common/DispatchStateTag';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  createDispatch,
  patchDispatchFilter,
  promoteQueue,
  removeDispatch,
  resetDispatchFilter,
  retryReconcileDispatch,
  selectBatches,
  selectDispatchFilter,
  selectDispatches,
  selectWaitingDispatches,
  withdrawDispatch,
} from '@/stores/ledgerSlice';
import { DISPATCH_STATES, type DispatchState } from '@/types/dispatch';
import type { Instrument } from '@/types/instrument';
import { describeOpsStatus } from '@/utils/reconcile';
import { freeSeats, occupiedSeats } from '@/types/batch';
import { ROUTES } from '@/router';
import { clearOrphanCalibrations, initDatabase, readOrphanCalibrations } from '@/utils/db';

interface DispatchFormValues {
  instrumentId: string;
  sendDate: dayjs.Dayjs | null;
  operator: string;
  remark: string;
}

interface DispatchRow {
  id: string;
  arrayName: string;
  stationCode: string;
  instrument: Instrument | undefined;
  model: string;
  serialNo: string;
  sendDate: string;
  state: DispatchState;
  batchCode: string;
  opsStatus: ReturnType<typeof describeOpsStatus>;
  mismatchReason: string;
  returnReason: string;
  queueOrder: number;
}

export default function DispatchLedger() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const dispatches = useAppSelector(selectDispatches);
  const batches = useAppSelector(selectBatches);
  const waiting = useAppSelector(selectWaitingDispatches);
  const filter = useAppSelector(selectDispatchFilter);

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [orphans, setOrphans] = useState(() => readOrphanCalibrations());
  const [form] = Form.useForm<DispatchFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
    setOrphans(readOrphanCalibrations());
  }, [arrays.length]);

  const stationIndex = useMemo(() => new Map(stations.map((row) => [row.id, row])), [stations]);
  const arrayIndex = useMemo(() => new Map(arrays.map((row) => [row.id, row])), [arrays]);
  const batchIndex = useMemo(() => new Map(batches.map((row) => [row.id, row])), [batches]);

  /** 可送检仪器：排除仍在送检流程中的仪器 */
  const selectableInstruments = useMemo(() => {
    const busy = new Set(
      dispatches
        .filter((row) => ['排队中', '已排入', '已出车', '对账失败'].includes(row.state))
        .map((row) => row.instrumentId)
    );
    return instruments.filter((instrument) => !busy.has(instrument.id));
  }, [dispatches, instruments]);

  const rows = useMemo<DispatchRow[]>(() => {
    return dispatches
      .map((record) => {
        const station = stationIndex.get(record.stationId);
        const array = station ? arrayIndex.get(station.arrayId) : undefined;
        const instrument = instruments.find((row) => row.id === record.instrumentId);
        const batch = record.batchId ? batchIndex.get(record.batchId) ?? null : null;
        return {
          id: record.id,
          arrayName: array?.name ?? '未知台阵',
          stationCode: record.stationCode,
          instrument,
          model: instrument?.model ?? '仪器已删除',
          serialNo: record.serialNo,
          sendDate: record.sendDate,
          state: record.state,
          batchCode: batch?.code ?? '',
          opsStatus: describeOpsStatus(record, batch),
          mismatchReason: record.mismatchReason,
          returnReason: record.returnReason,
          queueOrder: record.queueOrder,
        };
      })
      .filter((row) => {
        const keyword = filter.keyword.trim();
        if (keyword.length > 0) {
          const haystack = `${row.stationCode}${row.serialNo}${row.model}${row.arrayName}${row.batchCode}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.states.length > 0 && !filter.states.includes(row.state)) return false;
        if (filter.batchId) {
          const record = dispatches.find((item) => item.id === row.id);
          if (record?.batchId !== filter.batchId) return false;
        }
        return true;
      })
      .sort((a, b) => b.sendDate.localeCompare(a.sendDate) || b.queueOrder - a.queueOrder);
  }, [arrayIndex, batchIndex, dispatches, filter, instruments, stationIndex]);

  const totals = useMemo(
    () => ({
      all: dispatches.length,
      waiting: dispatches.filter((row) => row.state === '排队中').length,
      seated: dispatches.filter((row) => row.state === '已排入').length,
      departed: dispatches.filter((row) => row.state === '已出车').length,
      stored: dispatches.filter((row) => row.state === '已入库').length,
      returned: dispatches.filter((row) => row.state === '已退回').length,
      failed: dispatches.filter((row) => row.state === '对账失败').length,
    }),
    [dispatches]
  );

  /** 待出车批次名额概览（这趟还能带几台、哪些台站还没轮到） */
  const pendingBatches = useMemo(
    () =>
      batches
        .filter((batch) => batch.state === '待出车')
        .sort((a, b) => a.departDate.localeCompare(b.departDate)),
    [batches]
  );

  /** 还没轮到的台站：有仪器但本周期没有任何在途/已入库送检登记 */
  const stationsNotTurned = useMemo(() => {
    const recentTurned = new Set(
      dispatches
        .filter((row) => ['已排入', '已出车', '已入库', '已退回', '对账失败'].includes(row.state))
        .map((row) => row.stationId)
    );
    const counts = new Map<string, number>();
    instruments.forEach((instrument) => {
      counts.set(instrument.stationId, (counts.get(instrument.stationId) ?? 0) + 1);
    });
    return stations
      .filter((station) => counts.has(station.id) && !recentTurned.has(station.id))
      .map((station) => ({
        station,
        arrayName: arrayIndex.get(station.arrayId)?.name ?? '未知台阵',
        count: counts.get(station.id) ?? 0,
      }));
  }, [arrayIndex, dispatches, instruments, stations]);

  const openCreate = () => {
    form.setFieldsValue({
      instrumentId: selectableInstruments[0]?.id ?? undefined,
      sendDate: dayjs(),
      operator: '',
      remark: '',
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const instrument = instruments.find((row) => row.id === values.instrumentId);
    if (!instrument) {
      message.warning('请选择要送检的仪器');
      return;
    }
    setSubmitting(true);
    try {
      const result = await dispatch(
        createDispatch({
          instrumentId: instrument.id,
          stationId: instrument.stationId,
          sendDate: values.sendDate ? values.sendDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          operator: values.operator.trim(),
          remark: values.remark?.trim() ?? '',
        })
      );
      if (createDispatch.fulfilled.match(result)) {
        message.success(result.payload.queued ? '名额已满，已排队等下一趟' : `已排入批次 ${result.payload.batchCode}`);
        setModalOpen(false);
      } else {
        message.error(result.payload as string);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async (id: string) => {
    const result = await dispatch(retryReconcileDispatch({ dispatchId: id, refreshFromOps: true }));
    if (retryReconcileDispatch.fulfilled.match(result)) {
      const state = result.payload.state;
      message.success(
        state === '已入库'
          ? `对账一致，仪器照旧入库，结论「${result.payload.reason}」`
          : state === '已退回'
            ? '该台仅作退回处理，其余仪器照旧入库'
            : state === '对账失败'
              ? `仍对不上（${result.payload.reason}），继续挂起待确认`
              : '台站码与序列号已对上，等计量站补结论'
      );
    } else {
      message.error(result.payload as string);
    }
  };

  const filterModel = {
    keyword: filter.keyword,
    states: filter.states,
    batchId: filter.batchId,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            运维班送检台账
          </Typography.Title>
          <p className="gb-hint">
            按台站记仪器安装位置与送检登记；登记时自动占用最早一趟待出车批次名额，名额满了排队等下一趟。
            与计量站按「台站码 + 序列号」对账，对不上的先挂起等确认、不写结论。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CarOutlined />} onClick={() => navigate(ROUTES.batches)}>
            去计量站出车批次
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            disabled={waiting.length === 0 || pendingBatches.every((batch) => freeSeats(batch) === 0)}
            onClick={() =>
              void dispatch(promoteQueue())
                .unwrap()
                .then((result) => message.success(`已按排队顺序补排 ${result.moved} 台`))
                .catch((error: string) => message.warning(error))
            }
          >
            有名额时按队补排
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记送检
          </Button>
        </Space>
      </div>

      {orphans.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          closable
          message={`旧数据升级时有 ${orphans.length} 条标定切不进出车批次（仪器或台站档案缺失），已单列待确认`}
          description={
            <Space direction="vertical" size={4}>
              {orphans.slice(0, 5).map((orphan) => (
                <span key={orphan.calibration.id} className="gb-hint gb-mono">
                  {orphan.calibration.date} · 仪器 {orphan.calibration.instrumentId} · {orphan.reason}
                </span>
              ))}
              {orphans.length > 5 ? <span className="gb-hint">…其余 {orphans.length - 5} 条略</span> : null}
              <Button
                size="small"
                onClick={() => {
                  clearOrphanCalibrations();
                  setOrphans([]);
                  message.success('已知悉，单列提示已清除（原始标定记录仍保留）');
                }}
              >
                已知悉，清除提示
              </Button>
            </Space>
          }
        />
      ) : null}

      <div className="gb-stats-row">
        <StatBadge label="送检登记" value={totals.all} suffix="台次" tone="primary" />
        <StatBadge label="排队等下一趟" value={totals.waiting} suffix="台" tone="warning" />
        <StatBadge label="已排入待出车" value={totals.seated} suffix="台" tone="info" />
        <StatBadge label="已出车" value={totals.departed} suffix="台" tone="default" />
        <StatBadge label="已入库" value={totals.stored} suffix="台" tone="success" />
        <StatBadge label="已退回" value={totals.returned} suffix="台" tone="warning" />
        <StatBadge label="对账失败挂起" value={totals.failed} suffix="台" tone={totals.failed > 0 ? 'danger' : 'success'} />
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'states',
            label: '送检状态',
            options: DISPATCH_STATES.map((state) => ({ label: state, value: state })),
          },
          {
            key: 'batchId',
            label: '出车批次',
            multiple: false,
            options: batches.map((batch) => ({ label: `${batch.code}（${batch.state}）`, value: batch.id })),
          },
        ]}
        keywordPlaceholder="搜索台站码 / 序列号 / 型号 / 批次号"
        showReset
        onChange={(next) => {
          dispatch(
            patchDispatchFilter({
              keyword: next.keyword,
              states: Array.isArray(next.states) ? (next.states as DispatchState[]) : [],
              batchId: typeof next.batchId === 'string' ? next.batchId : '',
            })
          );
        }}
        onReset={() => dispatch(resetDispatchFilter())}
      />

      {rows.length === 0 ? (
        <EmptyPanel
          title={dispatches.length === 0 ? '还没有送检登记' : '没有符合条件的登记'}
          description="登记后系统自动按名额排入最早一趟待出车批次；已出车批次照旧不动，满额后的登记排队等下一趟。"
          actionText="登记送检"
          onAction={openCreate}
        />
      ) : (
        <Table
          rowKey="id"
          className="gb-table-compact"
          dataSource={rows}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          columns={[
            {
              title: '台站 / 台阵',
              width: 180,
              render: (_: unknown, row: DispatchRow) => (
                <div>
                  <div className="gb-mono">{row.stationCode}</div>
                  <div className="gb-hint">{row.arrayName}</div>
                </div>
              ),
            },
            {
              title: '仪器',
              width: 230,
              render: (_: unknown, row: DispatchRow) => (
                <div>
                  <div>{row.model}</div>
                  <div className="gb-hint gb-mono">{row.serialNo}</div>
                </div>
              ),
            },
            { title: '送检日期', dataIndex: 'sendDate', width: 110, className: 'gb-mono' },
            {
              title: '出车批次',
              width: 130,
              render: (_: unknown, row: DispatchRow) =>
                row.batchCode ? <Tag color="blue">{row.batchCode}</Tag> : <Tag>排队等下一趟</Tag>,
            },
            {
              title: '送检状态',
              width: 120,
              render: (_: unknown, row: DispatchRow) => <DispatchStateTag state={row.state} />,
            },
            {
              title: '对账情况',
              width: 220,
              render: (_: unknown, row: DispatchRow) => {
                if (row.state === '对账失败') {
                  return (
                    <div>
                      <Tag color="error">{row.mismatchReason || '对不上'}</Tag>
                      <div className="gb-hint">挂起待确认，暂不写结论</div>
                    </div>
                  );
                }
                if (row.state === '已退回') {
                  return (
                    <div>
                      <Tag color="orange">计量站只退这一台</Tag>
                      <div className="gb-hint">{row.returnReason || '随车退回'}</div>
                    </div>
                  );
                }
                return <span className="gb-hint">{row.opsStatus}</span>;
              },
            },
            {
              title: '操作',
              width: 240,
              render: (_: unknown, row: DispatchRow) => (
                <Space size={6} wrap>
                  {row.state === '排队中' ? (
                    <Popconfirm
                      title="删除送检登记"
                      description="该登记尚未出车，确认删除？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void dispatch(removeDispatch(row.id))
                          .unwrap()
                          .then(() => message.success('送检登记已删除'))
                          .catch((error: string) => message.warning(error))
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>
                  ) : null}
                  {row.state === '已排入' ? (
                    <Button
                      size="small"
                      icon={<RollbackOutlined />}
                      onClick={() =>
                        void dispatch(withdrawDispatch(row.id))
                          .unwrap()
                          .then(() => message.success('已撤回，回到队尾等下一趟'))
                          .catch((error: string) => message.warning(error))
                      }
                    >
                      撤回排队
                    </Button>
                  ) : null}
                  {row.state === '对账失败' ? (
                    <>
                      <Button size="small" type="primary" icon={<RedoOutlined />} onClick={() => void handleRetry(row.id)}>
                        按运维班侧重试
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          void dispatch(withdrawDispatch(row.id))
                            .unwrap()
                            .then(() => message.success('已撤回到队尾，等下一趟重新出车'))
                            .catch((error: string) => message.warning(error))
                        }
                      >
                        改下一趟
                      </Button>
                    </>
                  ) : null}
                  {row.state === '已出车' ? (
                    <Button size="small" icon={<RedoOutlined />} onClick={() => void handleRetry(row.id)}>
                      对账入库
                    </Button>
                  ) : null}
                  {row.state === '已入库' ? <span className="gb-hint">记录照旧不动</span> : null}
                  {row.state === '已退回' ? (
                    <Button size="small" type="primary" onClick={openCreate}>
                      重新登记送检
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      )}

      <Row gutter={[14, 14]}>
        <Col xs={24} xl={12}>
          <Card className="gb-panel" size="small" title="待出车批次名额（计量站侧）">
            {pendingBatches.length === 0 ? (
              <EmptyPanel title="暂无待出车批次" description="到计量站出车批次页新建一趟出车并填写能带台数。" compact />
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {pendingBatches.map((batch) => {
                  const free = freeSeats(batch);
                  return (
                    <div
                      key={batch.id}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}
                    >
                      <div>
                        <Tag color="blue">{batch.code}</Tag>
                        <span className="gb-mono">出车 {batch.departDate}</span>
                        <div className="gb-hint">
                          {batch.agency || '未填写机构'} · 已排 {occupiedSeats(batch)}/{batch.capacity} 台
                        </div>
                      </div>
                      <Tag color={free > 0 ? 'green' : 'default'} style={{ borderRadius: 999 }}>
                        {free > 0 ? `还能带 ${free} 台` : '名额已满'}
                      </Tag>
                    </div>
                  );
                })}
                <p className="gb-hint" style={{ marginBottom: 0 }}>
                  名额满了以后登记的仪器自动排队；批次出车后不补排、照旧不动。
                </p>
              </Space>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={6}>
          <Card className="gb-panel" size="small" title={`排队队列（${waiting.length} 台）`}>
            {waiting.length === 0 ? (
              <EmptyPanel title="队列为空" description="暂无等待下一趟的仪器。" compact />
            ) : (
              <Timeline
                items={waiting.map((record, index) => {
                  const station = stationIndex.get(record.stationId);
                  return {
                    color: index === 0 && pendingBatches.some((batch) => freeSeats(batch) > 0) ? 'green' : 'gray',
                    children: (
                      <span>
                        <b className="gb-mono">{station?.code ?? record.stationCode}</b>
                        <span className="gb-hint"> · {record.serialNo}</span>
                        <div className="gb-hint">送检 {record.sendDate}</div>
                      </span>
                    ),
                  };
                })}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={6}>
          <Card className="gb-panel" size="small" title={`还没轮到的台站（${stationsNotTurned.length}）`}>
            {stationsNotTurned.length === 0 ? (
              <EmptyPanel title="台站均已安排" description="各台站仪器都已有送检或出车记录。" compact />
            ) : (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {stationsNotTurned.map(({ station, arrayName, count }) => (
                  <div key={station.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      <b className="gb-mono">{station.code}</b>
                      <span className="gb-hint"> · {arrayName}</span>
                    </span>
                    <Tag>{count} 台待安排</Tag>
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={modalOpen}
        title="登记送检（运维班）"
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText="登记并按名额排入"
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="instrumentId" label="送检仪器（按安装台站列出）" rules={[{ required: true, message: '请选择仪器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择台站上的仪器"
              options={selectableInstruments.map((instrument) => {
                const station = stationIndex.get(instrument.stationId);
                const array = station ? arrayIndex.get(station.arrayId) : undefined;
                return {
                  label: `${array?.name ?? ''} / ${station?.code ?? '未知台站'} · ${instrument.model}（${instrument.serialNo}）`,
                  value: instrument.id,
                };
              })}
              notFoundContent="所有仪器都在送检流程中，等退回或入库后再登记"
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sendDate" label="送检日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="经办人" rules={[{ required: true, message: '请填写经办人' }]}>
                <Input maxLength={20} placeholder="如：周渝" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：随 JL2026-04 批次送省地震局计量站" />
          </Form.Item>
          <p className="gb-hint">
            台站码与序列号取仪器安装位置台账快照作为对账基准；计量站现场记录对不上时先挂起，以运维班这侧确认为准。
          </p>
        </Form>
      </Modal>
    </div>
  );
}
