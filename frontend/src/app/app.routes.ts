import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { ChatStoreService } from './core/services/chat-store.service';

const authGuard: CanActivateFn = () => {
  const store = inject(ChatStoreService);
  if (store.isAuthenticated()) {
    return true;
  }
  return inject(Router).createUrlTree(['/setup']);
};

const guestGuard: CanActivateFn = () => {
  const store = inject(ChatStoreService);
  if (!store.isAuthenticated()) {
    return true;
  }
  return inject(Router).createUrlTree(['/chats']);
};

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'chats'
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
