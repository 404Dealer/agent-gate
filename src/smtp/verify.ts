import nodemailer from 'nodemailer';
import {
  buildSmtpTransportOptions,
  type SmtpTransportOptions
} from '../providers/email-smtp.js';

export interface SmtpVerifyTransport {
  verify(): Promise<boolean>;
}

export type SmtpVerifyTransportFactory = (options: SmtpTransportOptions) => SmtpVerifyTransport;

const createVerifyTransport: SmtpVerifyTransportFactory = (options) =>
  nodemailer.createTransport(options) as unknown as SmtpVerifyTransport;

export async function verifyGmailSmtpCredentials(
  email: string,
  password: string,
  transportFactory: SmtpVerifyTransportFactory = createVerifyTransport
): Promise<void> {
  const transport = transportFactory(buildSmtpTransportOptions({
    host: 'smtp.gmail.com',
    port: 465,
    tlsMode: 'implicit',
    username: email,
    password
  }));

  try {
    const verified = await transport.verify();
    if (!verified) throw new Error('verification rejected');
  } catch {
    throw new Error('SMTP credential verification failed');
  }
}