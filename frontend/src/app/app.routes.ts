import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { ChatStoreService } from './core/services/chat-store.service';

const authGuard: CanActivateFn = async () => {
  const store = inject(ChatStoreService);
  const router = inject(Router);
  await store.ensureSessionReady();
  if (store.isAuthenticated()) {
    await store.initialize();
    return true;
  }
  return router.createUrlTree(['/setup']);
};

const guestGuard: CanActivateFn = async () => {
  const store = inject(ChatStoreService);
  const router = inject(Router);
  await store.ensureSessionReady();
  if (!store.isAuthenticated()) {
    return true;
  }
  return router.createUrlTree(['/chats']);
};

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'chats'
  },
  {
    path: 'setup/verify',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/setup/setup-verify.component').then((m) => m.SetupVerifyComponent)
  },
  {
    path: 'setup',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/setup/setup.component').then((m) => m.SetupComponent)
  },
  {
    path: 'chats',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/chat/chat-shell.component').then((m) => m.ChatShellComponent)
  },
  {
    path: '**',
    redirectTo: 'chats'
  }
];
