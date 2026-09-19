// ============================================
// Recovery Confirmation Panel
// ============================================
// The human-in-the-loop gate between the agent's recovery proposal and the
// writeback that executes it. Ported from PostalOps' RerouteConfirmationPanel,
// adapted from parcel rerouting to passenger-connection recovery.
//
// Three states:
//   1. Reasoning  — staged agent reasoning, each step showing the ACTUAL query
//                   it ran and the real result it computed (not a fixed script).
//   2. Decision   — the recommendation, the knowledge-graph path it traversed,
//                   the business rules it evaluated, and the governance
//                   metadata for every drafted action.
//   3. No plan    — the selected flight has no at-risk connection to recover.
//
// The panel never executes anything itself: it calls onConfirm, and the console
// owns the writeback.

import React from 'react';
import {
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowRightLeft,
  ShieldCheck,
} from 'lucide-react';

const backdropStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  background: 'rgba(15, 23, 42, 0.35)',
  backdropFilter: 'blur(4px)',
};

const dialogStyle = (width) => ({
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 10000,
  width,
  maxWidth: '94vw',
  maxHeight: '90vh',
  overflowY: 'auto',
  background: 'rgba(255,255,255,0.98)',
  backdropFilter: 'blur(20px)',
  border: '1px solid rgba(148,163,184,0.25)',
  borderRadius: '16px',
  boxShadow: '0 25px 60px -12px rgba(0,0,0,0.25)',
  fontFamily: 'var(--sans, system-ui)',
  padding: '22px',
});

const sectionLabel = {
  fontSize: '10px',
  fontWeight: 700,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: '8px',
};

export default function RecoveryConfirmationPanel({
  isOpen,
  onClose,
  onConfirm,
  plan,            // the computeRecoveryPlan() result, or null
  flightId,
  mctMinutes,
  destAirportLoad, // predictAirportLoad() entry for the connecting hub
  isExecuting,
  isCompleted,
  isLoading,
  reasoningStage,
  reasoningLog,    // [{ step, result }]
}) {
  if (!isOpen) return null;

  const safeStage = reasoningStage ?? 0;

  // The eight reasoning steps mirror what the KG engine actually does — each
  // `detail` is the query the step runs, and `reasoningLog` supplies the real
  // result once the step completes.
  const reasoningSteps = [
    { icon: '🔍', label: 'Resolving flight in the knowledge graph', detail: `kg.getFlight('${flightId}')` },
    { icon: '📊', label: 'Reading arrival delay and telemetry', detail: 'delayMinutes, scheduledArrivalUtc, status → Telemetry Event' },
    { icon: '🗺️', label: 'Traversing onward connection edges', detail: `kg.getKeyConnectionsFrom(destinationAirportId)` },
    { icon: '⏱️', label: 'Applying minimum connection time', detail: `bufferMin = onwardDeparture − actualArrival; atRisk = bufferMin < ${mctMinutes}` },
    { icon: '🛫', label: 'Checking connecting-hub gate pressure', detail: 'delayPredictor.predictAirportLoad() → utilization, headroom' },
    { icon: '🎫', label: 'Evaluating rebooking inventory', detail: 'rebookPartnerOptions per at-risk connection, ordered by buffer' },
    { icon: '🧮', label: 'Scoring plan confidence', detail: 'confidence = f(worst buffer) over all at-risk connections' },
    { icon: '✅', label: 'Drafting governance-ready actions', detail: 'requiresApproval, approverRole, auditLogged per action' },
  ];

  // ── No recoverable disruption ──────────────────────────────────────────
  if (!isLoading && !plan) {
    return (
      <>
        <div onClick={onClose} style={backdropStyle} />
        <div style={{ ...dialogStyle('440px'), textAlign: 'center' }}>
          <div style={{ fontSize: '38px', marginBottom: '10px' }}>✅</div>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--ink, #0f172a)', marginBottom: '8px' }}>
            No Recovery Required
          </div>
          <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.5, marginBottom: '20px' }}>
            Every onward connection from <strong>{flightId}</strong> still clears the {mctMinutes}-minute minimum
            connection time after the current delay. The agent found nothing to rebook.
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '10px 28px',
              fontSize: '12px',
              fontWeight: 600,
              border: '1px solid var(--line, #e5e7eb)',
              borderRadius: '8px',
              background: 'var(--surface, #f8fafc)',
              cursor: 'pointer',
              color: 'var(--ink, #0f172a)',
            }}
          >
            Dismiss
          </button>
        </div>
      </>
    );
  }

  // ── Staged agent reasoning ─────────────────────────────────────────────
  if (isLoading || !plan) {
    return (
      <>
        <div onClick={onClose} style={backdropStyle} />
        <div style={dialogStyle('520px')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #6366f1, #3b82f6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Loader2 size={18} className="spin-animation" style={{ color: '#fff' }} />
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ink, #0f172a)' }}>AI Agent Reasoning</div>
              <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '1px' }}>
                Traversing knowledge graph for {flightId}
              </div>
            </div>
          </div>

          <div style={{ height: '3px', background: 'var(--surface, #f1f5f9)', borderRadius: '2px', marginBottom: '16px', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                borderRadius: '2px',
                background: 'linear-gradient(90deg, #6366f1, #3b82f6, #059669)',
                width: `${Math.min(((safeStage + 1) / reasoningSteps.length) * 100, 100)}%`,
                transition: 'width 400ms ease',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '380px', overflowY: 'auto' }}>
            {reasoningSteps.map((step, i) => {
              if (i > safeStage) return null;
              const isActive = i === safeStage;
              const isDone = i < safeStage;
              const logEntry = (reasoningLog || []).find((l) => l.step === i);

              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    padding: '8px 10px',
                    background: isActive ? 'rgba(99, 102, 241, 0.06)' : isDone ? 'rgba(5, 150, 105, 0.03)' : 'transparent',
                    border: `1px solid ${isActive ? 'rgba(99, 102, 241, 0.15)' : isDone ? 'rgba(5, 150, 105, 0.08)' : 'transparent'}`,
                    borderRadius: '8px',
                    transition: 'all 300ms ease',
                  }}
                >
                  <span style={{ fontSize: '14px', flexShrink: 0, marginTop: '1px' }}>{isDone ? '✓' : step.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: isDone ? '#059669' : isActive ? '#6366f1' : 'var(--ink, #334155)' }}>
                      {step.label}
                      {isActive && <Loader2 size={10} className="spin-animation" style={{ display: 'inline-block', marginLeft: '6px', verticalAlign: 'middle' }} />}
                    </div>
                    {isDone && logEntry ? (
                      <div
                        style={{
                          fontSize: '9px',
                          fontFamily: 'var(--mono, monospace)',
                          color: '#059669',
                          background: 'rgba(5, 150, 105, 0.06)',
                          padding: '3px 6px',
                          borderRadius: '4px',
                          marginTop: '3px',
                          lineHeight: 1.4,
                        }}
                      >
                        {logEntry.result}
                      </div>
                    ) : (
                      <div
                        style={{
                          fontSize: '9px',
                          fontFamily: 'var(--mono, monospace)',
                          color: isActive ? '#6366f1' : '#64748b',
                          marginTop: '2px',
                          lineHeight: 1.4,
                          opacity: isActive ? 1 : 0.7,
                        }}
                      >
                        {step.detail}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '12px', fontSize: '9px', color: '#94a3b8', textAlign: 'center' }}>
            Step {Math.min(safeStage + 1, reasoningSteps.length)} of {reasoningSteps.length}
          </div>
        </div>
      </>
    );
  }

  // ── Decision ───────────────────────────────────────────────────────────
  const rec = plan.recommendation;
  const rebookActions = plan.actions.filter((a) => a.actionType === 'RebookPassengers');
  const gateActions = plan.actions.filter((a) => a.actionType === 'ReallocateGateCapacity');
  const worstBuffer = Math.min(...plan.atRiskConnections.map((c) => c.bufferMin));
  const utilPct = destAirportLoad?.utilizationPct ?? 0;

  // Business rules the agent evaluated — each derived from the plan itself, so
  // a rule that genuinely fails blocks the confirm button.
  const businessRules = [
    {
      rule: 'Every at-risk connection has a rebooking option',
      passed: rebookActions.every((a) => a.parameters.alternateConnectingFlightId !== 'TBD'),
      detail: `${rebookActions.filter((a) => a.parameters.alternateConnectingFlightId !== 'TBD').length} of ${rebookActions.length} connection(s) have a named partner flight`,
    },
    {
      rule: 'Connecting hub has gate headroom',
      passed: utilPct < 95,
      detail: destAirportLoad
        ? `${destAirportLoad.airportId} at ${utilPct}% gate utilization (${destAirportLoad.headroom?.toLocaleString?.() ?? '—'} pax/hr headroom)`
        : 'No live utilization reading for the connecting hub',
    },
    {
      rule: 'Missed-connection window is recoverable same-day',
      passed: worstBuffer > -180,
      detail: `Worst buffer ${worstBuffer} min against a ${mctMinutes}-minute MCT`,
    },
    {
      rule: 'All actions carry an approver role',
      passed: plan.actions.every((a) => a.governance?.approverRole),
      detail: [...new Set(plan.actions.map((a) => a.governance?.approverRole))].filter(Boolean).join(', ') || '—',
    },
    {
      rule: 'All actions are audit-logged',
      passed: plan.actions.every((a) => a.governance?.auditLogged),
      detail: `${plan.actions.length} action(s) written to action_execution_log.csv on execute`,
    },
  ];
  const allRulesPassed = businessRules.every((r) => r.passed);

  return (
    <>
      <div onClick={onClose} style={backdropStyle} />
      <div style={dialogStyle('560px')}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #6366f1, #3b82f6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ArrowRightLeft size={16} style={{ color: '#fff' }} />
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--ink, #0f172a)' }}>Recover Connections — AI Decision</div>
              <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '1px' }}>Agent traversed the knowledge graph and evaluated business rules</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: '4px', borderRadius: '6px' }}>
            <X size={18} />
          </button>
        </div>

        {/* Decision summary */}
        <div
          style={{
            padding: '12px 14px',
            marginBottom: '14px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(59,130,246,0.06))',
            border: '1px solid rgba(99,102,241,0.15)',
          }}
        >
          <div style={{ ...sectionLabel, color: '#6366f1', marginBottom: '6px' }}>Decision</div>
          <div style={{ fontSize: '12px', color: 'var(--ink, #1e293b)', lineHeight: 1.6 }}>
            Rebook <b>{plan.totalPaxAtRisk.toLocaleString()} passengers</b> across{' '}
            <b style={{ color: '#dc2626' }}>{plan.atRiskConnections.length} at-risk connection(s)</b> from{' '}
            <b>{plan.flightId}</b> ({plan.flightOrigin} → {plan.flightDestination}), delayed{' '}
            <b>+{plan.delayMinutes} min</b>.
            {gateActions.length > 0 && (
              <> Also reallocating <b style={{ color: '#059669' }}>{gateActions[0].parameters.additionalGateHours} gate-hours</b> at {gateActions[0].parameters.airportId}.</>
            )}
          </div>
        </div>

        {/* KG path */}
        {plan.knowledgeGraphPath?.length > 0 && (
          <div style={{ marginBottom: '14px' }}>
            <div style={sectionLabel}>Knowledge Graph Traversal</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: '10px 12px',
                background: 'var(--surface, #f8fafc)',
                borderRadius: '8px',
                border: '1px solid var(--line, #e5e7eb)',
                fontFamily: 'var(--mono, monospace)',
              }}
            >
              {plan.knowledgeGraphPath.map((node, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      color: i === 0 ? '#dc2626' : i === plan.knowledgeGraphPath.length - 1 ? '#059669' : '#334155',
                      background: i === 0 ? '#fef2f2' : i === plan.knowledgeGraphPath.length - 1 ? '#ecfdf5' : '#f1f5f9',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {node}
                  </span>
                  {i < plan.knowledgeGraphPath.length - 1 && <span style={{ margin: '0 4px', color: '#cbd5e1', fontSize: '11px' }}>→</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* At-risk connections */}
        <div style={{ marginBottom: '14px' }}>
          <div style={sectionLabel}>At-Risk Connections</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--line, #e5e7eb)', borderRadius: '8px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10.5px' }}>
              <thead>
                <tr style={{ background: 'var(--surface, #f8fafc)' }}>
                  {['Onward', 'To', 'Buffer', 'Pax', 'Rebook onto'].map((h) => (
                    <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 700, color: '#64748b', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.atRiskConnections.map((c) => {
                  const action = rebookActions.find((a) => a.context.originalConnectingFlightId === c.onwardFlightId);
                  return (
                    <tr key={c.onwardFlightId}>
                      <td style={{ padding: '6px 8px', fontFamily: 'var(--mono, monospace)', fontWeight: 600 }}>{c.onwardFlightId}</td>
                      <td style={{ padding: '6px 8px' }}>{c.destinationAirportId}</td>
                      <td style={{ padding: '6px 8px', color: '#dc2626', fontWeight: 600 }}>{c.bufferMin} min</td>
                      <td style={{ padding: '6px 8px' }}>{c.paxAtRisk}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'var(--mono, monospace)' }}>
                        {action?.parameters.alternateConnectingFlightId || 'TBD'}
                        {action?.parameters.voucherPolicy === 'HOTEL_MEAL' && (
                          <span style={{ marginLeft: '5px', fontSize: '8.5px', padding: '1px 4px', borderRadius: '3px', background: '#fffbeb', color: '#d97706', fontWeight: 700 }}>
                            VOUCHER
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Business rules */}
        <div style={{ marginBottom: '14px' }}>
          <div style={sectionLabel}>Business Rules Evaluated</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {businessRules.map((br, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 10px',
                  background: br.passed ? 'rgba(5,150,105,0.04)' : 'rgba(220,38,38,0.04)',
                  border: `1px solid ${br.passed ? 'rgba(5,150,105,0.12)' : 'rgba(220,38,38,0.12)'}`,
                  borderRadius: '6px',
                }}
              >
                <span style={{ fontSize: '12px', flexShrink: 0, color: br.passed ? '#059669' : '#dc2626' }}>{br.passed ? '✓' : '✗'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--ink, #1e293b)' }}>{br.rule}</div>
                  <div style={{ fontSize: '9px', color: '#94a3b8', marginTop: '1px' }}>{br.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Agent reasoning */}
        <div
          style={{
            fontSize: '11px',
            color: 'var(--ink, #334155)',
            lineHeight: 1.6,
            padding: '10px 12px',
            background: 'rgba(99, 102, 241, 0.04)',
            border: '1px solid rgba(99, 102, 241, 0.1)',
            borderRadius: '8px',
            marginBottom: '14px',
          }}
        >
          <span style={{ fontWeight: 700, color: '#6366f1' }}>AI Reasoning: </span>
          {rec.summary}
        </div>

        {/* Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '14px' }}>
          {[
            { value: plan.totalPaxAtRisk.toLocaleString(), label: 'pax to rebook', color: '#dc2626' },
            { value: `${Math.round((rec.confidence || 0) * 100)}%`, label: 'confidence', color: '#3b82f6' },
            { value: (rec.estimatedVoucherPax ?? 0).toLocaleString(), label: 'pax needing vouchers', color: '#d97706' },
          ].map((m) => (
            <div key={m.label} style={{ textAlign: 'center', padding: '10px 8px', background: 'var(--surface, #f8fafc)', borderRadius: '8px', border: '1px solid var(--line, #e5e7eb)' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: m.color, fontFamily: 'var(--mono, monospace)' }}>{m.value}</div>
              <div style={{ fontSize: '9px', color: '#64748b', marginTop: '2px' }}>{m.label}</div>
            </div>
          ))}
        </div>

        {/* Governance */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            marginBottom: '16px',
            borderRadius: '8px',
            background: 'rgba(148,163,184,0.08)',
            border: '1px solid var(--line, #e5e7eb)',
          }}
        >
          <ShieldCheck size={14} style={{ color: '#64748b', flexShrink: 0 }} />
          <div style={{ fontSize: '10px', color: '#475569', lineHeight: 1.5 }}>
            {plan.actions.length} governance-ready action(s) — approver role(s){' '}
            <b>{[...new Set(plan.actions.map((a) => a.governance?.approverRole))].filter(Boolean).join(', ')}</b>. On execute, each is
            appended to <code style={{ fontFamily: 'var(--mono, monospace)' }}>action_execution_log.csv</code> and the affected flight
            records are updated.
          </div>
        </div>

        {/* Confirm / reject */}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: '10px',
              fontSize: '12px',
              fontWeight: 600,
              border: '1px solid #fca5a5',
              borderRadius: '10px',
              background: '#fef2f2',
              cursor: 'pointer',
              color: '#dc2626',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            <X size={14} /> Reject
          </button>
          <button
            onClick={onConfirm}
            disabled={isExecuting || isCompleted || !allRulesPassed}
            style={{
              flex: 2,
              padding: '10px',
              fontSize: '12px',
              fontWeight: 700,
              border: 'none',
              borderRadius: '10px',
              cursor: isExecuting || isCompleted || !allRulesPassed ? 'default' : 'pointer',
              background: isCompleted
                ? 'linear-gradient(135deg, #059669, #10b981)'
                : !allRulesPassed
                  ? '#94a3b8'
                  : 'linear-gradient(135deg, #6366f1, #3b82f6)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              opacity: isExecuting ? 0.75 : 1,
              boxShadow: isCompleted ? '0 4px 12px rgba(5,150,105,0.3)' : !allRulesPassed ? 'none' : '0 4px 12px rgba(99,102,241,0.3)',
            }}
          >
            {isCompleted ? (
              <>
                <CheckCircle2 size={14} /> Passengers Rebooked Successfully
              </>
            ) : isExecuting ? (
              <>
                <Loader2 size={14} className="spin-animation" /> Writing back to PSS &amp; AODB…
              </>
            ) : !allRulesPassed ? (
              <>
                <AlertTriangle size={14} /> Rules Not Satisfied
              </>
            ) : (
              <>
                <CheckCircle2 size={14} /> Confirm &amp; Execute
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}
