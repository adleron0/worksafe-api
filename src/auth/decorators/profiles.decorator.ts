import { SetMetadata } from '@nestjs/common';

export const PROFILE_KEY = 'profile';
export const Profiles = (...profile: string[]) =>
  SetMetadata(PROFILE_KEY, profile);
