/**
 * 计量站出车批次（/batches）
 * 按出车批次记出车日期、一趟能带台数（名额）与逐台结论。
 * - 运维班登记的送检仪器按名额自动排入；批次名额满后排队等下一趟；
 * - 出车后批次冻结照旧不动；回来后录逐台结论并与运维班按台站码 + 序列号对账；
 * - 对不上先挂起，不写结论；退回某台只退这一台，其余照旧入库。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  PlusOutlined,
  RedoOutlined,
  RollbackOutlined,
  SolutionOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar from '@/components/common/FilterBar';
import QualifyTag from '@/components/common/QualifyTag';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import {
  correctItemIdentity,
  createBatch,
  departBatch,
  patchBatchFilter,
  reconcileBatch,
  removeBatch,
  resetBatchFilter,
  returnBatchItem,
  selectBatchFilter,
  selectBatches,
  selectDispatches,
  setBatchItemVerdict,
  updateBatch,
} from '@/stores/ledgerSlice';
import type { BatchDraft, BatchItemVerdict, CalibBatch } from '@/types/batch';
import { freeSeats, occupiedSeats } from '@/types/batch';
import { BATCH_STATES, type BatchState } from '@/types/batch';
import { RESPONSE_VERDICTS, SELF_NOISE_LIMIT, SENSITIVITY_RANGE, type ResponseVerdict } from '@/types/calibration';
import DispatchStateTag from '@/components/common/DispatchStateTag';
import { buildBatchReconcileRows } from '@/utils/reconcile';
import { ROUTES } from '@/router';
import { initDatabase } from '@/utils/db';

interface BatchFormValues {
  code: string;
  departDate: dayjs.Dayjs | null;
  capacity: number;
  agency: string;
  remark: string;
}

interface VerdictFormValues {
  sensitivity: number;
  selfNoise: number;
  verdict: ResponseVerdict;
  note: string;
}

interface IdentityFormValues {
  stationCode: string;
  serialNo: string;
}

export default function BatchBoard() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const batches = useAppSelector(selectBatches);
  const dispatches = useAppSelector(selectDispatches);
  const filter = useAppSelector(selectBatchFilter);

  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verdictTarget, setVerdictTarget] = useState<{ batch: CalibBatch; dispatchId: string } | null>(null);
  const [returnTarget, setReturnTarget] = useState<{ batch: CalibBatch; dispatchId: string } | null>(null);
  const [identityTarget, setIdentityTarget] = useState<{ batch: CalibBatch; dispatchId: string } | null>(null);
  const [batchForm] = Form.useForm<BatchFormValues>();
  const [verdictForm] = Form.useForm<VerdictFormValues>();
  const [identityForm] = Form.useForm<IdentityFormValues>();

  useEffect(() => {
    if (arrays.length === 0) void initDatabase();
  }, [arrays.length]);

  const dispatchIndex = useMemo(
    () => new Map(dispatches.map((row) => [row.id, row])),
    [dispatches]
  );

  const reconcileRowsByBatch = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildBatchReconcileRows>>();
    batches.forEach((batch) => {
      map.set(batch.id, buildBatchReconcileRows(batch, dispatchIndex, instruments, stations));
    });
    return map;
  }, [batches, dispatchIndex, instruments, stations]);

  const filteredBatches = useMemo(() => {
    const keyword = filter.keyword.trim();
    return batches
      .filter((batch) => {
        if (keyword.length > 0 && !`${batch.code}${batch.agency}${batch.remark}`.includes(keyword)) return false;
        if (filter.states.length > 0 && !filter.states.includes(batch.state)) return false;
        return true;
      })
      .sort((a, b) => b.departDate.localeCompare(a.departDate) || b.createdAt - a.createdAt);
  }, [batches, filter]);

  const totals = useMemo(() => {
    const pending = batches.filter((batch) => batch.state === '待出车');
    const departed = batches.filter((batch) => batch.state === '已出车');
    const pendingVerdict = dispatches.filter((row) => row.state === '已出车').length;
    const returned = dispatches.filter((row) => row.state === '已退回').length;
    const failed = dispatches.filter((row) => row.state === '对账失败').length;
    const seated = dispatches.filter((row) => row.state === '已排入').length;
    return {
      pending: pending.length,
      departed: departed.length,
      capacity: pending.reduce((sum, batch) => sum + batch.capacity, 0),
      seated,
      pendingVerdict,
      returned,
      failed,
    };
  }, [batches, dispatches]);

  const openBatchCreate = () => {
    setEditingBatchId(null);
    batchForm.setFieldsValue({
      code: `JL${dayjs().format('YYYY')}-${String(batches.length + 1).padStart(2, '0')}`,
      departDate: dayjs().add(7, 'day'),
      capacity: 4,
      agency: '省地震局计量站',
      remark: '',
    });
    setBatchModalOpen(true);
  };

  const openBatchEdit = (batch: CalibBatch) => {
    setEditingBatchId(batch.id);
    batchForm.setFieldsValue({
      code: batch.code,
      departDate: dayjs(batch.departDate),
      capacity: batch.capacity,
      agency: batch.agency,
      remark: batch.remark,
    });
    setBatchModalOpen(true);
  };

  const submitBatch = async () => {
    const values = await batchForm.validateFields();
    const payload: BatchDraft = {
      code: values.code.trim(),
      departDate: values.departDate ? values.departDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      capacity: Number(values.capacity),
      agency: values.agency.trim(),
      remark: values.remark?.trim() ?? '',
    };
    setSubmitting(true);
    try {
      const action = editingBatchId
        ? await dispatch(updateBatch({ id: editingBatchId, patch: payload }))
        : await dispatch(createBatch(payload));
      if (createBatch.rejected.match(action) || updateBatch.rejected.match(action)) {
        message.error(action.payload as string);
        return;
      }
      message.success(editingBatchId ? '批次已更新' : '出车批次已建，等待送检登记排入');
      setBatchModalOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openVerdict = (batch: CalibBatch, item: BatchItemVerdict) => {
    const instrument = instruments.find((row) => row.id === item.instrumentId);
    const range = SENSITIVITY_RANGE[instrument?.type ?? '宽频带'];
    setVerdictTarget({ batch, dispatchId: item.dispatchId });
    verdictForm.setFieldsValue({
      sensitivity: item.sensitivity ?? Number(((range.min + range.max) / 2).toFixed(1)),
      selfNoise: item.selfNoise ?? 1.5,
      verdict: item.verdict === '待判定' ? '合格' : item.verdict,
      note: item.note,
    });
  };

  const submitVerdict = async () => {
    if (!verdictTarget) return;
    const values = await verdictForm.validateFields();
    const result = await dispatch(
      setBatchItemVerdict({
        batchId: verdictTarget.batch.id,
        dispatchId: verdictTarget.dispatchId,
        sensitivity: Number(values.sensitivity),
        selfNoise: Number(values.selfNoise),
        verdict: values.verdict,
        note: values.note?.trim() ?? '',
      })
    );
    if (setBatchItemVerdict.rejected.match(result)) {
      message.error(result.payload as string);
      return;
    }
    message.success(`逐台结论已登记（自动初判「${result.payload?.autoVerdict}」），需运维班对账后入库`);
    setVerdictTarget(null);
  };

  const submitReturn = async (note: string) => {
    if (!returnTarget) return;
    const result = await dispatch(
      returnBatchItem({ batchId: returnTarget.batch.id, dispatchId: returnTarget.dispatchId, note })
    );
    if (returnBatchItem.rejected.match(result)) {
      message.error(result.payload as string);
      return;
    }
    message.success('该台仅作退回处理，同车其余仪器照旧入库');
    setReturnTarget(null);
  };

  const openIdentity = (batch: CalibBatch, item: BatchItemVerdict) => {
    setIdentityTarget({ batch, dispatchId: item.dispatchId });
    identityForm.setFieldsValue({ stationCode: item.stationCode, serialNo: item.serialNo });
  };

  const submitIdentity = async () => {
    if (!identityTarget) return;
    const values = await identityForm.validateFields();
    const result = await dispatch(
      correctItemIdentity({
        batchId: identityTarget.batch.id,
        dispatchId: identityTarget.dispatchId,
        stationCode: values.stationCode.trim(),
        serialNo: values.serialNo.trim(),
      })
    );
    if (correctItemIdentity.rejected.match(result)) {
      message.error(result.payload as string);
      return;
    }
    message.success('现场记录已更正，可整批重新对账');
    setIdentityTarget(null);
  };

  const filterModel = { keyword: filter.keyword, states: filter.states };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            计量站出车批次
          </Typography.Title>
          <p className="gb-hint">
            按出车批次记出车日期、能带台数和逐台结论；已出车批次照旧不动。逐台结论需与运维班按台站码 +
            序列号对账一致后才入库，对不上先挂起；退回某台只退这一台。
          </p>
        </div>
        <Space wrap>
          <Button icon={<SolutionOutlined />} onClick={() => navigate(ROUTES.dispatches)}>
            去运维班送检台账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openBatchCreate}>
            新建出车批次
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="待出车批次" value={totals.pending} suffix="趟" tone="info" />
        <StatBadge label="已出车批次" value={totals.departed} suffix="趟" tone="default" />
        <StatBadge label="待出车名额" value={totals.capacity} suffix="台" tone="primary" />
        <StatBadge label="已排入" value={totals.seated} suffix="台" tone="info" />
        <StatBadge label="待结论" value={totals.pendingVerdict} suffix="台" tone="warning" />
        <StatBadge label="已退回" value={totals.returned} suffix="台" tone="warning" />
        <StatBadge label="对账挂起" value={totals.failed} suffix="台" tone={totals.failed > 0 ? 'danger' : 'success'} />
      </div>

      <FilterBar
        modelValue={filterModel}
        selects={[
          {
            key: 'states',
            label: '批次状态',
            options: BATCH_STATES.map((state) => ({ label: state, value: state })),
          },
        ]}
        keywordPlaceholder="搜索批次号 / 机构 / 备注"
        onChange={(next) =>
          dispatch(
            patchBatchFilter({
              keyword: next.keyword,
              states: Array.isArray(next.states) ? (next.states as BatchState[]) : [],
            })
          )
        }
        onReset={() => dispatch(resetBatchFilter())}
      />

      {filteredBatches.length === 0 ? (
        <EmptyPanel
          title={batches.length === 0 ? '还没有出车批次' : '没有符合条件的批次'}
          description="新建批次并填写出车日期与一趟能带台数，运维班登记送检后会按名额自动排入。"
          actionText="新建出车批次"
          onAction={openBatchCreate}
        />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {filteredBatches.map((batch) => {
            const rows = reconcileRowsByBatch.get(batch.id) ?? [];
            const occupied = occupiedSeats(batch);
            const free = freeSeats(batch);
            return (
              <Card
                key={batch.id}
                className="gb-panel"
                size="small"
                title={
                  <Space wrap>
                    <b>{batch.code}</b>
                    <Tag color={batch.state === '已出车' ? 'processing' : 'blue'}>{batch.state}</Tag>
                    <span className="gb-hint gb-mono">出车 {batch.departDate}</span>
                    <Tag>{batch.agency || '未填写机构'}</Tag>
                  </Space>
                }
                extra={
                  <Space wrap>
                    <Tag color={free > 0 && batch.state === '待出车' ? 'green' : 'default'}>
                      名额 {occupied}/{batch.capacity}
                      {batch.state === '待出车' ? `（剩 ${free}）` : ''}
                    </Tag>
                    {batch.state === '待出车' ? (
                      <>
                        <Button size="small" icon={<EditOutlined />} onClick={() => openBatchEdit(batch)}>
                          编辑
                        </Button>
                        <Popconfirm
                          title="确认出车？"
                          description={`本趟将带 ${occupied} 台仪器；排队中的仪器不随车，出车后记录冻结。`}
                          okText="确认出车"
                          cancelText="取消"
                          onConfirm={() =>
                            void dispatch(departBatch(batch.id))
                              .unwrap()
                              .then(() => message.success(`批次 ${batch.code} 已出车`))
                              .catch((error: string) => message.warning(error))
                          }
                        >
                          <Button size="small" type="primary" icon={<ExportOutlined />} disabled={occupied === 0}>
                            出车
                          </Button>
                        </Popconfirm>
                        <Popconfirm
                          title="删除该批次？"
                          description="已排入的送检登记将全部退回排队等下一趟。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() =>
                            void dispatch(removeBatch(batch.id))
                              .unwrap()
                              .then(() => message.success('批次已删除，排入登记退回排队'))
                              .catch((error: string) => message.warning(error))
                          }
                        >
                          <Button size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </>
                    ) : (
                      <Button
                        size="small"
                        type="primary"
                        icon={<CheckCircleOutlined />}
                        onClick={() =>
                          void dispatch(reconcileBatch(batch.id))
                            .unwrap()
                            .then((summary) =>
                              message.success(
                                `对账完成：入库 ${summary.入库}、退回 ${summary.退回}、待结论 ${summary.待结论}、挂起 ${summary.挂起}`
                              )
                            )
                            .catch((error: string) => message.warning(error))
                        }
                      >
                        整批对账
                      </Button>
                    )}
                  </Space>
                }
              >
                {batch.items.length === 0 ? (
                  <EmptyPanel title="本批次还没有仪器排入" description="等运维班登记送检后会按名额自动排入。" compact />
                ) : (
                  <Table
                    rowKey={(row) => row.item.dispatchId}
                    size="small"
                    className="gb-table-compact"
                    dataSource={rows}
                    pagination={false}
                    columns={[
                      {
                        title: '台站码',
                        width: 140,
                        render: (_: unknown, row) => (
                          <Space size={6}>
                            <span className="gb-mono">{row.item.stationCode}</span>
                            {!row.stationCodeMatch ? <Tag color="error">台站码不符</Tag> : null}
                          </Space>
                        ),
                      },
                      {
                        title: '序列号',
                        width: 220,
                        render: (_: unknown, row) => (
                          <Space size={2} direction="vertical">
                            <span className="gb-mono">{row.item.serialNo}</span>
                            {!row.serialNoMatch ? <Tag color="error">序列号不符</Tag> : null}
                            {!row.instrumentFound ? <Tag color="error">档案缺失</Tag> : null}
                          </Space>
                        ),
                      },
                      {
                        title: '运维班台账',
                        width: 200,
                        render: (_: unknown, row) =>
                          row.dispatch ? (
                            <div>
                              <div className="gb-mono">
                                {row.dispatch.stationCode} · {row.dispatch.serialNo}
                              </div>
                              <div className="gb-hint">
                                {instruments.find((ins) => ins.id === row.item.instrumentId)?.model ?? ''}
                              </div>
                            </div>
                          ) : (
                            <Tag color="error">运维班未登记</Tag>
                          ),
                      },
                      {
                        title: '灵敏度 / 自噪',
                        width: 150,
                        align: 'right',
                        render: (_: unknown, row) =>
                          row.item.sensitivity === null ? (
                            <span className="gb-hint">未录</span>
                          ) : (
                            <div className="gb-mono">
                              <div>{row.item.sensitivity}</div>
                              <div className="gb-hint">自噪 {row.item.selfNoise ?? '—'}</div>
                            </div>
                          ),
                      },
                      {
                        title: '逐台结论',
                        width: 150,
                        render: (_: unknown, row) =>
                          row.item.returned ? (
                            <Tag color="orange">已退回</Tag>
                          ) : (
                            <QualifyTag
                              verdict={row.item.verdict}
                              sensitivity={row.item.sensitivity ?? undefined}
                              selfNoise={row.item.selfNoise ?? undefined}
                              size="small"
                            />
                          ),
                      },
                      {
                        title: '送检状态',
                        width: 110,
                        render: (_: unknown, row) =>
                          row.dispatch ? <DispatchStateTag state={row.dispatch.state} withTip={false} /> : '—',
                      },
                      {
                        title: '操作',
                        width: 300,
                        render: (_: unknown, row) => {
                          if (batch.state !== '已出车') {
                            return <span className="gb-hint">出车后方可登记结论</span>;
                          }
                          const locked = row.dispatch?.state === '已入库' || row.dispatch?.state === '已退回';
                          return (
                            <Space size={6} wrap>
                              {!row.item.returned && !locked ? (
                                <Button size="small" type="primary" onClick={() => openVerdict(batch, row.item)}>
                                  录结论
                                </Button>
                              ) : null}
                              {!row.item.returned && row.dispatch?.state !== '已入库' ? (
                                <Button size="small" danger icon={<RollbackOutlined />} onClick={() => setReturnTarget({ batch, dispatchId: row.item.dispatchId })}>
                                  只退这台
                                </Button>
                              ) : null}
                              {(!row.stationCodeMatch || !row.serialNoMatch || !row.instrumentFound) &&
                              row.dispatch?.state !== '已入库' ? (
                                <Button size="small" icon={<RedoOutlined />} onClick={() => openIdentity(batch, row.item)}>
                                  核对现场记录
                                </Button>
                              ) : null}
                              {locked ? <span className="gb-hint">照旧不动</span> : null}
                            </Space>
                          );
                        },
                      },
                    ]}
                  />
                )}
                <Row justify="space-between" style={{ marginTop: 8 }}>
                  <span className="gb-hint">
                    对账基准：运维班送检登记的台站码 + 序列号；对不上先挂起，等运维班确认后重试，计量站不替其下结论。
                  </span>
                  {batch.remark ? <span className="gb-hint">备注：{batch.remark}</span> : null}
                </Row>
              </Card>
            );
          })}
        </Space>
      )}

      {/* 新建 / 编辑批次 */}
      <Modal
        open={batchModalOpen}
        title={editingBatchId ? '编辑出车批次' : '新建出车批次'}
        onCancel={() => setBatchModalOpen(false)}
        onOk={() => void submitBatch()}
        confirmLoading={submitting}
        okText={editingBatchId ? '保存修改' : '建立批次'}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="code" label="批次号" rules={[{ required: true, message: '请填写批次号' }]}>
                <Input maxLength={30} placeholder="如：JL2026-04" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="departDate" label="出车日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="capacity" label="一趟能带台数（名额）" rules={[{ required: true }]}>
                <InputNumber min={1} max={100} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="agency" label="标定机构">
                <Input maxLength={40} placeholder="如：省地震局计量站" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：龙门峡方向，两天往返" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 录逐台结论 */}
      <Modal
        open={!!verdictTarget}
        title="登记逐台结论（计量站）"
        onCancel={() => setVerdictTarget(null)}
        onOk={() => void submitVerdict()}
        okText="保存结论"
        destroyOnClose
      >
        <Form form={verdictForm} layout="vertical" preserve={false}>
          <p className="gb-hint">
            结论将随批次与运维班送检台账对账；若该台台站码 / 序列号挂起，需先确认一致，本次保存不会自动入库。
          </p>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sensitivity" label="灵敏度 (V·s/m)" rules={[{ required: true }]}>
                <InputNumber min={0} max={100000} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="selfNoise" label={`自噪（限值 ${SELF_NOISE_LIMIT}）`} rules={[{ required: true }]}>
                <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="verdict" label="脉冲响应结论" rules={[{ required: true }]}>
            <Select options={RESPONSE_VERDICTS.map((verdict) => ({ label: verdict, value: verdict }))} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={100} placeholder="如：脉冲响应合格" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 退回某台 */}
      <ReturnItemModal
        open={!!returnTarget}
        onCancel={() => setReturnTarget(null)}
        onConfirm={(note) => void submitReturn(note)}
      />

      {/* 计量站核对现场记录 */}
      <Modal
        open={!!identityTarget}
        title="核对现场记录（计量站侧）"
        onCancel={() => setIdentityTarget(null)}
        onOk={() => void submitIdentity()}
        okText="保存并参与重对"
        destroyOnClose
      >
        <Form form={identityForm} layout="vertical" preserve={false}>
          <p className="gb-hint">
            仅修正本批次现场抄录的台站码 / 序列号；运维班送检台账仍为对账基准，最终以两边一致为准。
          </p>
          <Form.Item name="stationCode" label="台站码" rules={[{ required: true, message: '请填写台站码' }]}>
            <Input maxLength={20} />
          </Form.Item>
          <Form.Item name="serialNo" label="序列号" rules={[{ required: true, message: '请填写序列号' }]}>
            <Input maxLength={60} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function ReturnItemModal({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setNote('');
  }, [open]);
  return (
    <Modal
      open={open}
      title="只退回这一台"
      onCancel={onCancel}
      onOk={() => onConfirm(note.trim() || '计量站随车退回')}
      okText="确认退回该台"
      okButtonProps={{ danger: true }}
      destroyOnClose
    >
      <p className="gb-hint">仅该台退出本趟，不写结论；同车其余仪器对账后照旧入库。</p>
      <Input.TextArea
        rows={3}
        maxLength={100}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="退回原因，如：外观受损 / 序列号对不上"
      />
    </Modal>
  );
}
