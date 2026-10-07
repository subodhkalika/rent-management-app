import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ladderFixtures } from '@rms/contract';
import { CascadeDiffDialog } from './CascadeDiffDialog';

const l1 = ladderFixtures.find((f) => f.name.startsWith('L1'))!;
const l2 = ladderFixtures.find((f) => f.name.startsWith('L2'))!;

describe('CascadeDiffDialog — the cascade preview, before anything is written', () => {
  it("L1: shows the step changing, and every later clause step recomputing (the 'good relations' case)", () => {
    render(
      <CascadeDiffDialog
        open
        onOpenChange={() => {}}
        clause={l1.clause}
        steps={l1.steps}
        index={l1.index}
        newRentCents={l1.newRentCents}
        currency="INR"
        calendar="gregorian"
        onConfirm={() => {}}
      />,
    );

    // The step itself: from 6,453.00 to 5,300.00.
    expect(screen.getByText(/change apr 1, 2028 from/i)).toBeInTheDocument();
    expect(screen.getByText('₹6,453.00')).toBeInTheDocument();
    expect(screen.getByText('₹5,300.00')).toBeInTheDocument();

    // Every later clause step recomputes, matching L1's expected ladder exactly.
    expect(screen.getByText(/this also updates/i)).toBeInTheDocument();
    expect(screen.getByText(/apr 1, 2029 ₹7,098\.00 → ₹5,830\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/apr 1, 2030 ₹7,808\.00 → ₹6,413\.00/i)).toBeInTheDocument();

    // Nothing is listed as "unchanged" — L1's ladder has no manual step after the override.
    expect(screen.queryByText(/unchanged, because you set it by hand/i)).not.toBeInTheDocument();
  });

  it('L2: a manual step later in the ladder is listed as unchanged, never recomputed', () => {
    render(
      <CascadeDiffDialog
        open
        onOpenChange={() => {}}
        clause={l2.clause}
        steps={l2.steps}
        index={l2.index}
        newRentCents={l2.newRentCents}
        currency="INR"
        calendar="gregorian"
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/this also updates/i)).toBeInTheDocument();
    expect(screen.getByText(/unchanged, because you set it by hand/i)).toBeInTheDocument();
    // The manual step (2031-04-01, ₹8,000.00) is listed once, under "unchanged" —
    // never under the "also updates" recompute list.
    expect(screen.getByText(/apr 1, 2031 ₹8,000\.00/i)).toBeInTheDocument();
    expect(screen.queryByText(/apr 1, 2031 ₹8,000\.00 →/i)).not.toBeInTheDocument();
  });

  it('turning the cascade toggle off changes only the targeted step', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CascadeDiffDialog
        open
        onOpenChange={() => {}}
        clause={l1.clause}
        steps={l1.steps}
        index={l1.index}
        newRentCents={l1.newRentCents}
        currency="INR"
        calendar="gregorian"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('switch', { name: /also update later years/i }));
    expect(screen.getByText(/only this step changes/i)).toBeInTheDocument();
    expect(screen.queryByText(/this also updates/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const applied = onConfirm.mock.calls[0]![0];
    // Only the touched index changed; every later step is untouched from `l1.steps`.
    expect(applied[l1.index]).toMatchObject({ rentCents: l1.newRentCents, source: 'manual' });
    for (let i = l1.index + 1; i < l1.steps.length; i += 1) {
      expect(applied[i]).toEqual(l1.steps[i]);
    }
  });

  it('applying with the cascade on writes exactly recomputeLadderFrom\'s own result (L1)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CascadeDiffDialog
        open
        onOpenChange={() => {}}
        clause={l1.clause}
        steps={l1.steps}
        index={l1.index}
        newRentCents={l1.newRentCents}
        currency="INR"
        calendar="gregorian"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^apply$/i }));

    expect(onConfirm).toHaveBeenCalledWith(l1.expected);
  });
});
