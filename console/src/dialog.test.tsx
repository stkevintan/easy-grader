import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './dialog';

describe('对话框', () => {
  it('提交进行中不能关闭，提交完成后才关闭', async () => {
    let finish!: () => void;
    const onClose = vi.fn();
    render(
      <Dialog
        title="停用账号"
        onSubmit={() => new Promise<void>((r) => (finish = r))}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '确定' }));
    // 取消按钮被禁用；Escape（cancel 事件）和点遮罩也不关闭
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    const dialog = document.querySelector('dialog')!;
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('提交失败的错误出现在 alert 区域里，弹窗不关闭', async () => {
    const onClose = vi.fn();
    render(
      <Dialog
        title="新建用户"
        onSubmit={async () => {
          throw new Error('用户名已存在');
        }}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名已存在');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('没在提交时 Escape 和取消都能关闭', async () => {
    const onClose = vi.fn();
    render(<Dialog title="确认" onSubmit={() => undefined} onClose={onClose} />);
    fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
