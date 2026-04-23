/**
 * Standard OP-20 contract method definitions for the signing page.
 * Based on IOP20Contract interface from the opnet SDK.
 */

export type ParamType = 'address' | 'u256' | 'bytes';

export interface MethodParam {
  name: string;
  type: ParamType;
  placeholder?: string;
}

export interface MethodDef {
  name: string;
  label: string;
  params: MethodParam[];
}

export const OP20_METHODS: MethodDef[] = [
  {
    name: 'transfer',
    label: 'Transfer',
    params: [
      { name: 'to', type: 'address', placeholder: '0x... or opt1...' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
    ],
  },
  {
    name: 'transferFrom',
    label: 'Transfer From',
    params: [
      { name: 'from', type: 'address', placeholder: 'From address' },
      { name: 'to', type: 'address', placeholder: 'To address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
    ],
  },
  {
    name: 'safeTransfer',
    label: 'Safe Transfer',
    params: [
      { name: 'to', type: 'address', placeholder: '0x... or opt1...' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
      { name: 'data', type: 'bytes', placeholder: 'Callback data (hex)' },
    ],
  },
  {
    name: 'safeTransferFrom',
    label: 'Safe Transfer From',
    params: [
      { name: 'from', type: 'address', placeholder: 'From address' },
      { name: 'to', type: 'address', placeholder: 'To address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
      { name: 'data', type: 'bytes', placeholder: 'Callback data (hex)' },
    ],
  },
  {
    name: 'increaseAllowance',
    label: 'Increase Allowance',
    params: [
      { name: 'spender', type: 'address', placeholder: 'Spender address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount to increase' },
    ],
  },
  {
    name: 'decreaseAllowance',
    label: 'Decrease Allowance',
    params: [
      { name: 'spender', type: 'address', placeholder: 'Spender address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount to decrease' },
    ],
  },
  {
    name: 'burn',
    label: 'Burn',
    params: [
      { name: 'amount', type: 'u256', placeholder: 'Amount to burn' },
    ],
  },
  {
    name: 'mint',
    label: 'Mint',
    params: [
      { name: 'address', type: 'address', placeholder: 'Recipient address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount to mint' },
    ],
  },
];
